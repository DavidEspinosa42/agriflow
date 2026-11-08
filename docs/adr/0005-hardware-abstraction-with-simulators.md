# ADR 0005: Hardware abstraction with simulators

Status: Accepted

## Context

Development happens on Windows, deployment on a Raspberry Pi with GPIO and a USB reader.

## Decision

Define interfaces for pump relay, flow meter, RFID reader and buttons. Ship a simulator and a GPIO implementation behind them, selected by HARDWARE_DRIVER.

## Consequences

Domain and service code is testable without hardware. The real drivers need field testing on a Pi, listed in the roadmap.

## GPIO implementation

The GPIO driver drives the libgpiod v2 command line tools (`gpioset`, `gpiomon`, `gpioget`) instead of a native Node addon. This builds nowhere and runs on every Pi model, including the Pi 5, at the cost of spawning four small processes.

The relay line is held by one `gpioset --interactive` process fed through a pipe. If the controller exits or crashes the pipe closes, `gpioset` exits and the line is released, and an external pull-down resistor returns the relay to off. Interactive mode is a libgpiod build option, so the driver checks for it at startup and refuses to run without it.

Fail-safe rules in the driver: the E-stop input is polled with `gpioget` (every 250 ms by default) instead of watched for edges, because a line cannot be read while an edge monitor holds it and an edge stream cannot give the starting level without a gap in which a change could be missed. The hardware E-stop cuts pump power by itself, so the software only has to notice within a poll interval. An unread or failing E-stop counts as engaged. A stopped flow meter monitor makes `readPulses` throw, which the runtime treats as a fault with the pump switched off. If any monitor process dies, dispensing stays blocked until the controller restarts. On shutdown the off command is sent and `gpioset` is allowed to exit by itself.

Hardware requirement (not provided by software): the relay circuit must be fail-off on its own. Drive it through a transistor or opto-isolated board with a pull-down, power the pump contactor through the E-stop loop (ADR 0004), and bench test that killing the controller process with the pump running drops the pump. Software cannot guarantee what a released GPIO pin does on every board; a hardware watchdog that must be re-triggered to keep the relay energized is the recommended hardening and is listed in the roadmap.

Known limit: the pulse counter is updated asynchronously from the `gpiomon` pipe, so the final reading at stop can miss pulses still in flight (milliseconds of latency, plus pump spin-down after the relay opens). The session total is then slightly low, bounded by latency times flow rate, and finalized sessions are append-only, so a correction would be an audit entry. A dedicated hardware counter read synchronously, or a short settle step before finalizing, removes this; both are in the roadmap.

Pulses are counted by reading `gpiomon` output, which is adequate for typical flow meters (up to a few hundred pulses per second). A very high pulse rate needs a dedicated counter. The driver is covered by tests against fake processes; it must be bench tested on a real Pi (see the roadmap).
