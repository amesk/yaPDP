/*
 * devices/disk-service.js — block I/O service for the headless machine.
 *
 * Refactor stage 3 (disks): the shared diskIO/fetchBlock/createCache layer
 * of iopage.js moves onto a DOM-free service. One service instance lives on
 * the Machine (machine.disk) and is used by every block-oriented device:
 * RK11/RL11/RP11 disk controllers and the PTR11 paper-tape reader (OP_BYTE).
 *
 * The service is the "block device + write-back" layer of the storage
 * split discussed for the refactor:
 *
 *   machine.disk.mountDrive("rk0.dsk", {
 *       readBlock(n)  -> Uint8Array | Promise<Uint8Array>   // block n
 *       writeBlock(n, bytes) -> void | Promise              // flush target
 *   })
 *
 * "Getting the bytes" (DataLoader, IndexedDB, fetch) stays in the UI layer;
 * here the provider is the file system (Node) or the browser data sources
 * (a later step). Cache blocks are Uint16Array words (IO_BLOCKSIZE = 128KB),
 * identical to iopage.js. Guest writes go to the cache and are marked dirty;
 * flushDrive() pushes them to the provider's writeBlock.
 *
 * CPU-side glue (bus memory access, callback scheduling) is injected via
 * the machine host, so the service runs in Node tests without a CPU.
 *
 * UMD-ish: exports to window.yapdpCore in the browser, module.exports in
 * Node (used by tests).
 */
(function (global) {
    "use strict";

    const IO_BLOCKSIZE = 131072; // Cache block size (bytes)

    const OP_WRITE = 1;
    const OP_READ = 2;
    const OP_CHECK = 3;
    const OP_ACCUM = 4;
    const OP_BYTE = 5;

    /**
     * createCache — fill cache blocks from a byte array (1:1 from
     * iopage.js: packs little-endian words into Uint16Array blocks).
     */
    function createCache(cache, block, dataView) {
        const dataLength = dataView.length;

        for (let index = 0; index < dataLength; block++) {
            if (cache[block] === undefined) {
                cache[block] = new Uint16Array(IO_BLOCKSIZE >>> 1);
                for (let word = 0; word < (IO_BLOCKSIZE >>> 1) && index < dataLength; word++) {
                    let data = dataView[index++];
                    if (index < dataLength) {
                        data |= dataView[index++] << 8;
                    }
                    cache[block][word] = data;
                }
            } else {
                index += IO_BLOCKSIZE;
            }
        }
    }

    class DiskService {
        /**
         * @param {object} host  { busReadWord(addr), busWriteWord(addr, data),
         *                        writeByteByPhysical(addr, data),
         *                        mapUnibus(addr), scheduleCallback(fn, ...args) }
         */
        constructor(host = {}) {
            this.host = host;
            this.drives = {}; // url -> { provider, cache: [], dirty: Set }
        }

        /** mountDrive(url, provider) — attach a block provider. */
        mountDrive(url, provider) {
            this.drives[url] = {
                provider: provider || {},
                cache: [],
                dirty: new Set(),
            };
        }

        /** hasDrive(url) */
        hasDrive(url) {
            return Object.prototype.hasOwnProperty.call(this.drives, url);
        }

        /** _driveFor(controlBlock) — resolve the drive record by url. */
        _driveFor(controlBlock) {
            const url = controlBlock.url;
            if (!this.hasDrive(url)) {
                // Implicit mount: an empty provider (blocks read as zeros).
                this.mountDrive(url, {});
            }
            return this.drives[url];
        }

        /** markDirty(controlBlock, block) — record a guest-written block. */
        markDirty(controlBlock, block) {
            this._driveFor(controlBlock).dirty.add(block);
        }

        /**
         * _loadBlock(controlBlock, block) — ensure cache[block] is filled:
         * cached → done; otherwise provider.readBlock (bytes) → cache.
         */
        async _loadBlock(controlBlock, block) {
            const drive = this._driveFor(controlBlock);
            if (drive.cache[block] !== undefined) return;

            const provider = drive.provider;
            let bytes = null;
            if (provider && typeof provider.readBlock === "function") {
                const got = await provider.readBlock(block);
                if (got && got.length) bytes = got;
            }
            if (!bytes) {
                // Past end of image / no provider: create an explicit empty
                // cache block (all zeros). createCache() with zero-length
                // data creates nothing, which would re-trigger the cache
                // miss forever.
                drive.cache[block] = new Uint16Array(IO_BLOCKSIZE >>> 1);
                return;
            }
            createCache(drive.cache, block, bytes);
        }

        /**
         * flushDrive(url) — push every dirty block to the provider's
         * writeBlock (write-back). Returns a promise; resolves when done.
         */
        async flushDrive(url) {
            const drive = this.drives[url];
            if (!drive || drive.dirty.size === 0) return;
            const provider = drive.provider || {};
            if (typeof provider.writeBlock !== "function") {
                drive.dirty.clear(); // nowhere to persist — drop the marks
                return;
            }
            const pending = [];
            for (const block of drive.dirty) {
                const cacheBlock = drive.cache[block];
                if (!cacheBlock) continue;
                // Uint16Array words → little-endian bytes.
                const bytes = new Uint8Array(cacheBlock.length * 2);
                for (let w = 0; w < cacheBlock.length; w++) {
                    bytes[w * 2] = cacheBlock[w] & 0xFF;
                    bytes[w * 2 + 1] = cacheBlock[w] >>> 8;
                }
                pending.push(Promise.resolve(provider.writeBlock(block, bytes)));
            }
            drive.dirty.clear();
            await Promise.all(pending);
        }

        /** dirtyBlockCount(url) — for diagnostics/tests. */
        dirtyBlockCount(url) {
            const drive = this.drives[url];
            return drive ? drive.dirty.size : 0;
        }

        /**
         * io(controlBlock, operation, position, address, count, options) —
         * the diskIO() transfer loop, 1:1 from iopage.js. Transfers words
         * between the cache and the guest memory; on a cache miss it loads
         * the block and resumes via host.scheduleCallback (CPU context).
         */
        async io(controlBlock, operation, position, address, count, options) {
            const drive = this._driveFor(controlBlock);
            const cache = drive.cache;
            const host = this.host;
            let block = ~~(position / IO_BLOCKSIZE);

            // --- Cache hit path ---
            if (cache[block] !== undefined) {
                while (count > 0) {
                    let data;
                    let offset = position - block * IO_BLOCKSIZE;

                    if (offset >= IO_BLOCKSIZE) {
                        block++;
                        if (cache[block] === undefined) break;
                        offset = 0;
                    }

                    switch (operation) {
                        case OP_WRITE: // Write memory → cache
                        case OP_CHECK: // Compare memory with cache
                            data = host.busReadWord ? host.busReadWord(address) : -1;
                            if (data < 0) {
                                if (host.scheduleCallback) {
                                    host.scheduleCallback(controlBlock.callback, controlBlock, 2, position, address, count, options);
                                }
                                return;
                            }
                            if (operation === OP_WRITE) {
                                cache[block][offset >>> 1] = data;
                                this.markDirty(controlBlock, block);
                            } else if (data !== cache[block][offset >>> 1]) {
                                if (host.scheduleCallback) {
                                    host.scheduleCallback(controlBlock.callback, controlBlock, 3, position, address, count, options);
                                }
                                return;
                            }
                            address += 2; position += 2; count -= 2;
                            break;

                        case OP_READ: // Read cache → memory
                            data = cache[block][offset >>> 1];
                            if (count > 1) {
                                if (host.busWriteWord && host.busWriteWord(address, data) < 0) {
                                    if (host.scheduleCallback) {
                                        host.scheduleCallback(controlBlock.callback, controlBlock, 2, position, address, count, options);
                                    }
                                    return;
                                }
                                address += 2; position += 2; count -= 2;
                            } else {
                                if (host.writeByteByPhysical &&
                                    host.writeByteByPhysical(host.mapUnibus ? host.mapUnibus(address) : address, data & 0xFF) < 0) {
                                    if (host.scheduleCallback) {
                                        host.scheduleCallback(controlBlock.callback, controlBlock, 2, position, address, count, options);
                                    }
                                    return;
                                }
                                address += 1; position += 2; count--;
                            }
                            break;

                        case OP_ACCUM: // Tape record count accumulation
                            address = (cache[block][offset >>> 1] << 16) | (address >>> 16);
                            position += 2; count -= 2;
                            break;

                        case OP_BYTE: // PTR single-byte read
                            data = cache[block][offset >> 1];
                            address = (offset & 1 ? data >>> 8 : data & 0xFF);
                            position++; count = 0;
                            break;

                        default:
                            throw new Error("disk-service: unknown operation " + operation);
                    }
                }
            }

            // --- Cache miss path ---
            if (count > 0) {
                try {
                    await this._loadBlock(controlBlock, block);
                    if (host.scheduleCallback) {
                        host.scheduleCallback(this.io.bind(this), controlBlock, operation, position, address, count, options);
                    }
                } catch (err) {
                    if (host.scheduleCallback) {
                        host.scheduleCallback(controlBlock.callback, controlBlock, 9, position, address, count, options); // Network/fetch error
                    }
                }
                return;
            }

            // --- Completion ---
            if (host.scheduleCallback) {
                host.scheduleCallback(controlBlock.callback, controlBlock, 0, position, address, count, options); // Success
            }
        }
    }

    const api = { DiskService, IO_BLOCKSIZE, OP_WRITE, OP_READ, OP_CHECK, OP_ACCUM, OP_BYTE };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined") {
        window.yapdpCore = window.yapdpCore || {};
        window.yapdpCore.DiskService = DiskService;
    }
})(typeof window !== "undefined" ? window : globalThis);
