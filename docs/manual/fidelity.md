## Historical Fidelity and Limitations

yaPDP is an interactive environment for exploring the PDP-11/70 and the software ecosystem built around it. Its goal is to make historical computing tangible: start a machine, inspect its front panel, boot an operating system, run a program, and explore how people interacted with computers of this era.

Historical fidelity is important to that experience, but it does not mean that every component is reproduced with identical depth. yaPDP combines emulation, practical approximations, and interface design intended to make the environment approachable in a modern browser.

This page explains how to interpret the experience and where to be cautious.

### What yaPDP aims to preserve

#### The computing environment

yaPDP is designed around the PDP-11/70 and the experience of using a period-style computer system, rather than presenting a processor as an isolated programming target. The front panel, operating-system startup, interactive programs, storage devices, and peripheral interfaces help establish that wider context.

#### Real software and meaningful machine states

Where supported, yaPDP runs historical operating systems and programs in the emulated environment. Prepared machine states can place a visitor at a useful point in that experience: for example, ready to launch a program or already inside a demonstration.

A saved state is a practical entry point, not by itself proof that every detail of the surrounding hardware has been reproduced exactly. The software, machine configuration, required disk images, and state format all affect what can be restored and experienced.

#### Hardware-inspired interaction

The interface is intended to communicate the character of historical equipment. Controls and indicators are useful both for operating the emulated machine and for understanding the role of physical controls on systems such as the PDP-11/70.

Visual similarity and functional fidelity are related, but distinct. A control may look like its historical counterpart without modelling every electrical or mechanical detail of the original device.

### What to keep in mind

#### Emulation is not the same as a complete physical replica

yaPDP is software running on a modern computer. Its timing, rendering, input handling, storage, and browser integration are necessarily mediated by the host environment. It should not be assumed to reproduce every timing-sensitive hardware effect, electrical characteristic, mechanical behaviour, or failure mode of the original equipment.

The exact level of fidelity can differ between the CPU, memory, individual devices, and the user interface. Do not infer cycle-accurate or component-level accuracy unless it is explicitly documented for the relevant subsystem.

#### Peripheral devices may be modelled to different depths

Historical computer systems depended on devices such as terminals, paper-tape equipment, disks, and printers. In an interactive emulator, these devices also have to work through modern input and display mechanisms.

Depending on the device and feature, yaPDP may prioritise the aspects that matter most to the user-visible workflow—for example, entering characters, displaying output, or exploring a prepared scenario—rather than modelling every physical detail of the original mechanism.

Treat device-specific documentation as the source of truth for a particular peripheral. If a behaviour is not documented or tested, do not assume that it matches the original hardware in every respect.

#### Historical software has its own constraints

A program runs within the operating system, device configuration, and storage environment available to it. Some software may require a particular disk image, boot procedure, memory configuration, or peripheral. Other software may depend on conventions that are unfamiliar on modern systems.

A prepared state can simplify setup, but it does not remove every dependency. If a state refers to disk images or other resources that are not included in the state file, those resources must still be available to the receiving installation.

#### Browser and desktop environments can differ

The browser and desktop versions may differ in how they package resources, store changes, access local files, or behave when offline. A feature that depends on downloading a resource or fetching a state from another site may also be affected by network access and browser security rules such as Cross-Origin Resource Sharing (CORS).

For shared states, the fact that a URL opens in a browser tab does not necessarily mean that yaPDP can fetch it from JavaScript. The hosting server must permit the relevant cross-origin request. See the [machine-state](#machine-state) chapter for details.

#### A saved state is not a universal archival guarantee

A machine state records a particular configuration and point in time according to yaPDP's state format. Restoring it successfully can depend on the yaPDP version, state schema, required resources, and compatibility handling.

For long-term preservation, keep the state together with a description of its purpose, the yaPDP version used to create it, any required disk images, and instructions for reproducing the experience. Where possible, retain the original software and resource provenance as well.

### How to use yaPDP as a historical learning tool

For the most useful experience:

1. **Start with a prepared scenario.** It reduces setup work and lets you focus on the system or program being demonstrated.
2. **Read the scenario notes.** Check which operating system, disk images, peripherals, and controls it expects.
3. **Explore the machine, not just the program.** Notice the front panel, boot process, terminal interaction, and the role of storage and peripheral devices.
4. **Distinguish historical facts from emulator behaviour.** Use primary documentation and subsystem notes when making claims about the original hardware.
5. **Record the conditions of an experiment.** If you share a state or document a result, include the relevant yaPDP version and any non-default resources or settings.

yaPDP can make historical systems easier to explore, but it is not a substitute for original manuals, hardware documentation, or scholarly sources when exact historical claims matter.

### Reporting a fidelity issue

If you find a behaviour that appears inconsistent with the historical machine or software, a useful report includes:

- the yaPDP version or commit;
- the operating system, program, and machine state used;
- the device or behaviour in question;
- the steps needed to reproduce the observation;
- what you expected to happen and the historical source supporting that expectation, if available.

This helps distinguish an implementation defect from an intentional simplification, a software-specific limitation, or a difference caused by configuration.

### Summary

yaPDP aims to offer an engaging, historically grounded way to experience the PDP-11/70 and its software environment. It combines working software with a visual and interactive model of a period computing system, while making practical trade-offs for use on modern computers.

Use it to explore, experiment, and share reproducible moments from the machine's life. When exact hardware behaviour or historical interpretation matters, check the documentation for the specific subsystem and consult authoritative historical sources.