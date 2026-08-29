#!/usr/bin/env node
/**
 * yaPDP — Minimal PDP-11 disassembler for debugging bootstrap code.
 * Reads octal words from argv and prints a linear disassembly (no symbol
 * tracking, no branch targets beyond the raw offset). Good enough to decode
 * short RT-11 device-driver loops.
 *
 * Usage: node tools/_disasm.js 016705 177672 ...
 */
"use strict";

const WORDS = (process.argv.slice(2)).map((s) => parseInt(s, 8));

const REGS = ["R0", "R1", "R2", "R3", "R4", "R5", "SP", "PC"];

function modeStr(mode, reg) {
    switch (mode) {
        case 0: return REGS[reg];
        case 1: return "(" + REGS[reg] + ")";
        case 2: return "(" + REGS[reg] + ")+";
        case 3: return "@(" + REGS[reg] + ")+";
        case 4: return "-(" + REGS[reg] + ")";
        case 5: return "@-(" + REGS[reg] + ")";
        case 6: return "X(" + REGS[reg] + ")";
        case 7: return "@X(" + REGS[reg] + ")";
        default: return "?";
    }
}

const DOUBLE_OP = {
    1: "MOV", 2: "CMP", 3: "BIT", 4: "BIC", 5: "BIS", 6: "ADD",
    11: "MOVB", 12: "CMPB", 13: "BITB", 14: "BICB", 15: "BISB", 16: "SUB"
};

const SINGLE_OP = {
    0o0050: "CLR", 0o0051: "COM", 0o0052: "INC", 0o0053: "DEC",
    0o0054: "NEG", 0o0055: "ADC", 0o0056: "SBC", 0o0057: "TST",
    0o0060: "ROR", 0o0061: "ROL", 0o0062: "ASR", 0o0063: "ASL",
    0o0067: "SXT",
    0o1050: "CLRB", 0o1051: "COMB", 0o1052: "INCB", 0o1053: "DECB",
    0o1054: "NEGB", 0o1055: "ADCB", 0o1056: "SBCB", 0o1057: "TSTB",
    0o1060: "RORB", 0o1061: "ROLB", 0o1062: "ASRB", 0o1063: "ASLB"
};

const BRANCH = {
    0o0004: "BR", 0o0010: "BNE", 0o0014: "BEQ",
    0o0020: "BGE", 0o0024: "BLT", 0o0030: "BGT", 0o0034: "BLE",
    0o1000: "BPL", 0o1004: "BMI", 0o1010: "BHI", 0o1014: "BLOS",
    0o1020: "BVC", 0o1024: "BVS", 0o1030: "BHIS", 0o1034: "BLO"
};

function disasm(word) {
    const op = (word >>> 12) & 0xF;
    const srcMode = (word >>> 9) & 7;
    const srcReg = (word >>> 6) & 7;
    const dstMode = (word >>> 3) & 7;
    const dstReg = word & 7;

    if (op === 0) {
        const sop = (word >>> 6) & 0o177;
        if (sop === 0o0003) return "SWAB " + modeStr(dstMode, dstReg);
        if (sop === 0o0005) return "RESET";
        if (sop === 0o0007) return "RTS " + REGS[dstReg];
        if (sop === 0o0001) return "JMP " + modeStr(dstMode, dstReg);
        if (sop === 0o0004) return "JSR " + REGS[dstReg] + ", " + modeStr(dstMode, dstReg);
        const name = SINGLE_OP[sop];
        if (name) return name + " " + modeStr(dstMode, dstReg);
        return "?.op0:" + sop.toString(8) + " " + modeStr(dstMode, dstReg);
    }

    if (op >= 8 && op <= 15 && op !== 8) {
        // branch: high byte holds opcode + low byte offset
        const bop = (word >>> 8) & 0o377;
        const name = BRANCH[bop];
        const off = (word & 0xFF);
        const signed = off > 0x7F ? off - 0x100 : off;
        const target = signed + 2;
        return name ? `${name} ${(target >= 0 ? "+" : "")}${target.toString(8)}` :
            "?.br:" + bop.toString(8) + " " + off.toString(8);
    }

    if (op === 8) {
        // SOB? Actually op 8 = branch region too. Handle SOB (077rnn).
        if ((word >>> 6) === 0o77) {
            const reg = word & 7;
            const off = (word >>> 9) & 0x3F; // not exact; placeholder
            return "SOB " + REGS[reg] + ",?";
        }
        const bop = (word >>> 8) & 0o377;
        const name = BRANCH[bop];
        const off = (word & 0xFF);
        const signed = off > 0x7F ? off - 0x100 : off;
        const target = signed + 2;
        return name ? `${name} ${(target >= 0 ? "+" : "")}${target.toString(8)}` :
            "?.br:" + bop.toString(8);
    }

    const name = DOUBLE_OP[op];
    if (name) {
        return name + " " + modeStr(srcMode, srcReg) + ", " + modeStr(dstMode, dstReg);
    }
    return "?.op:" + op.toString(8);
}

WORDS.forEach((w, i) => {
    console.log((0o157520 + i * 2).toString(8) + ": " +
        w.toString(8).padStart(6, "0") + "   " + disasm(w));
});
