# Changelog

All notable changes to this module are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and entries are grouped by the
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) type of the change.

## [Unreleased]

## [3.0.0] - Unreleased

A rewrite in TypeScript for Companion 5, built on measurements of a real MX2-8x8-HDMI20-L on firmware 1.10.1b4. That is the only router it has been tested with. The ids of the actions, feedbacks and variables it keeps from v2 are unchanged and there is no upgrade script, but upgrading a v2 configuration has not been tested. Check your buttons after upgrading.

### ⚠ BREAKING CHANGES

- Requires Companion 5 (module API `@companion-module/base` 2.x) and Node 26. Stay on 2.x for Companion 3 or 4.
- Routers without the MX2 style `/MEDIA/XP/VIDEO` routing, such as those using `/MEDIA/VIDEO/XP`, are no longer supported until they have been measured. The log says so when connecting to one.
- Router presets are only read from `/MEDIA/PRESET`, no longer from `/PRESETS/AVC`.
- The **Switch USB Host** and **Run Macro** actions are removed. They used paths this router doesn't have, and couldn't be tested.
- Presets are rebuilt under new ids with a new look. Buttons already placed from v2 presets are unaffected, because Companion copies a preset when it is placed, but they keep the v2 look.

### Features

- **feat(routing):** actions and presets are available before a router has connected, or with none at all.
- **feat(routing):** a selected input flashes while taking it would change the selected output. An accepted take clears the selection, and a refused one keeps it.
- **feat(routing):** new auto-route mode in the connection settings, and an **AUTO** button that steps off, stage, cut. It takes or stages as soon as an input and an output are both selected.
- **feat(routing):** pressing an output lights the input on it, and pressing an input lights every output carrying it.
- **feat(routing):** new **Stage** actions and buttons build a set of routes. The one **TAKE** button sends what is staged and any selected pair as one command, so the router changes them together. Leaving Stage discards anything staged, and the log lists it.
- **feat(routing):** hold an input for a second to send it to every output, and a **Route an input to every output** action. Both follow the auto-route mode and leave locked outputs alone. Input buttons now select on release.
- **feat(routing):** new **Unroute an output** action.
- **feat(routing):** route changes made elsewhere, such as from the front panel or web interface, appear straight away and are logged. The module relies on the router's change messages and doesn't poll.
- **feat(presets):** new **Router preset is live** feedback and `live_preset` variable show when the router's routes match a preset. Presets stored on the router get a button each.
- **feat(presets):** with auto-route on Stage, a router preset's routes are staged instead of loaded, so what it would change shows before anything changes. Only the routes that would change are sent when taken. New **Router preset is staged** feedback.
- **feat(routing):** with auto-route on Stage, clearing a route is staged with the others.
- **feat(presets):** a router preset's name can be typed into its action while the router is offline.
- **feat(presets):** save router presets: a **SAVE PRESET** button that overwrites the next router preset pressed, **Overwrite a router preset** and **Create a router preset** actions, and a Router presets table on the ports page to save, rename, copy, delete and create them.
- **feat(presets):** SAVE then an input saves to that front-panel preset button, as on the router, making `ButtonN` when it is empty. New buttons for the front-panel presets show and recall whatever each holds. With routes staged, a save stores what a take would leave, without routing anything.
- **feat(power):** a **Put the router in standby, or wake it** action, with no preset. Standby is shown wherever it was done from: a connection warning, a log line, a `power` variable, a **Router in standby** feedback and a note on the ports page.
- **feat(connection):** the connection settings show the model, name, firmware and size of the router connected to. A firmware change is noticed within a few seconds, even when the connection doesn't drop, and the router is read again. While connecting, the settings say so and link to the connection's variables, which are live, as Companion can't update open settings.
- **feat(presets):** router presets added, renamed or deleted elsewhere appear straight away. The router announces those only on `/MEDIA/PRESET` itself, so the module subscribes there as well as to the presets.
- **feat(lock):** input locks: **LOCK** acts on the input or output pressed last and turns red while it's locked, a new **Lock or unlock a port** action and **Locked port** feedback, and input buttons turn red when locked. An output showing a locked input shows as locked too, as the router freezes it without saying so. Refused routes name the lock responsible.
- **feat(lock):** the lock action works on MX2 routers, can toggle, can act on the selected output, and has a preset. New **Locked output** feedback.
- **feat(mute):** new **Mute or unmute a port** action, **Muted port** feedback, and a **MUTE** button that acts on the input or output pressed last. A muted port stays routed and sends black. Mutes made elsewhere are logged.
- **feat(hotplug):** new **Hotplug an output** action and **HOTPLUG** button, which turn an output's 5V off and on to wake a display, and a **Hotplug an input** action, which makes a source read the EDID again. The ports page has a Hotplug button on every port, with a confirmation that lists the outputs an input hotplug drops. New **Hotplug in progress** feedback.
- **feat(hotplug):** DisplayPort ports hotplug by retraining the link, as they have no 5V or HPD setting. Each port's own settings decide this, so a router could mix port types. Measured on the MX2-8x8-DH-8DPio-A. A router with mixed ports hasn't been tested.
- **feat(clock):** new **Set the router's clock to Companion's time** action, and a **Router clock** section on the ports page showing how far out it is.
- **feat(status):** new **Signal on a port**, **Cable connected to a port** and **Port status** feedbacks. Input and output presets show a coloured border with the legend from the router's web interface.
- **feat(ports):** a page at `/instance/<connection label>/` to edit names, EDID and HDCP for all ports together, with a confirmation listing the changes, all-or-nothing checks, paste from a spreadsheet, Revert and Copy all. It also stores and deletes EDIDs in U slots. EDID changes go out as one command.
- **feat(ports):** the page updates live from the router's WebSocket, keeps anything being edited, and shows whether it is Live. Names with accents or emoji are sent as the nearest plain characters, and EDID lists can be filtered.
- **feat(ports):** the page is titled with the router's name, and can change it. New `router_name` variable.
- **feat(names):** a **Default names** button on the ports page and a **Set names to default** action, for ports and the router name.
- **feat(names):** new **Rename a port** action. Names changed elsewhere appear straight away and are logged.
- **feat(presets):** presets use Companion 5 layered buttons with a plain fallback, a blank styled button, and every button lights up while held.
- **feat(log):** logs what was found on connecting, reconnects, changes made elsewhere and anything the router refuses. Lines carry the connection's label as their source, and status messages name Lightware.
- **feat(connection):** when the router turns the module away because all its connections are in use, the log and status say so once, and the module keeps retrying.
- **feat(connection):** a lost connection is noticed within about 6 seconds without pressing anything, and the module keeps retrying until the router returns.
- **feat(actions):** port dropdowns say what to type in expression mode, whole-number fields only take whole numbers, and an output is hidden when **Use the selected output** is ticked.
- **perf(variables):** only variables that changed are sent, and router preset reads run one at a time, which matters most on large routers.
- **feat(tools):** `tools/lw3-capture.mjs` reads a router's whole LW3 tree without changing anything, and `yarn fake-router` runs a fake one.

### Bug Fixes

- **fix(routing):** routes are read from `DestinationConnectionStatus`, which is what this router has. v2 only asked for `DestinationConnectionList`, so route feedback was wrong until something changed.
- **fix(routing):** an output with nothing routed shows `None`, not a blank.
- **fix(presets):** a reply without presets no longer throws an error while reading them.
- **fix(errors):** errors from the router are now noticed. v2's check for them could never match.
- **fix(lock):** the lock action looked for a path MX2 routers don't have, so it never appeared on them.

### Not tested

- Soft reset.
- Whether the router announces a lock changed elsewhere.
- How many router presets the router can hold, and the longest name it allows. 46 characters was accepted.
- Any router other than the MX2-8x8-HDMI20-L, MX2-8X8-HDMI20-AUDIO, MX2-16x16-HDMI20-R, MX2-24x24-HDMI20-R and MX2-8x8-DH-8DPio-A, firmware other than 1.10.1b4 on the first two, 1.11.3b5 on the 16x16 and the DP router, and 1.12.0b8 on the 24x24, and any version of Companion other than 5.1.1 and 5.1.2. The L was later upgraded to 1.11.3b5, and only the connection limit and standby were measured on that.
- Standby and hotplug with real devices attached on the MX2-16x16-HDMI20-R and MX2-24x24-HDMI20-R.
- How many routes one command can hold beyond 24, which matters for a 48x48.
- A router with both HDMI and DisplayPort ports, and DisplayPort at 1.62 or 2.7 Gbps per lane, whose colours come from the router's own legend.
- The audio settings of the MX2-8X8-HDMI20-AUDIO, which the module leaves alone.
- Upgrading a v2 configuration.
- How many subscriptions a router allows. The ports page subscribes per port, so 96 on a 48x48.
- The connection limit on models other than the MX2-8x8-HDMI20-L, MX2-16x16-HDMI20-R, MX2-24x24-HDMI20-R and MX2-8x8-DH-8DPio-A.
- The ports page's WebSocket against the fake router, which has none by design.
- Whether the router announces a mute made from its front panel. Mutes made by command are announced.
- Hotplugging an input from the module, rather than by command. The command was tested with a MacBook on Input 1.

### Tested on hardware

The MX2-8x8-DH-8DPio-A on firmware 1.11.3b5, in Companion 5.1.2 with the built package: hotplug by link train on an output and an input, the ports page including on a phone, Default names, status borders at 5.4 Gbps per lane, routing, TAKE, holding an input for every output, locks, mutes, presets and front-panel preset buttons. A command line test of its spare ports matched the L's results for every LW3 command the module uses, except that DisplayPort ports have no 5V or HPD setting, took all 8 outputs in one command, and found the same limit of 15 connections.

The MX2-24x24-HDMI20-R on firmware 1.12.0b8, in Companion 5.1.2 with the built package: connecting, input and output buttons with the status border, holding an input for every output, recalling a stored preset, all 24 front-panel preset buttons, and the ports page at 48 rows, including on a phone. A command line test of its spare ports matched the L's results for every LW3 command the module uses, took all 24 outputs in one command, and found the same limit of 15 connections.

The MX2-16x16-HDMI20-R on firmware 1.11.3b5, in Companion 5.1.2 with the built package: connecting, input and output buttons with the status border, holding an input for every output, all 16 front-panel preset buttons, saving to them, and the ports page at 32 rows, including on a phone. A command line test of its spare ports matched the L's results for every LW3 command the module uses, took all 16 outputs in one command, and found the same limit of 15 connections.

The MX2-8X8-HDMI20-AUDIO in Companion 5.1.2, with the built package: routing, TAKE, holding an input for every output, locks, mutes, hotplug, saving router and front-panel presets, and the ports page, including on a phone. A command line test of its spare ports matched the L's results for every LW3 command the module uses. Standby wasn't tried on it.

In Companion 5.1.1, and again after moving to Node 26 on Companion 5.1.2 (routing, TAKE, status borders, the ports page and the built package): recalling router presets, the live preset feedback, toggling locks, the auto-route modes, staging router presets, staged clears, a route and a clear in one command, and a locked output staying staged while the rest of a preset is taken. The ports page was tried on spare ports: names including `( ) # %`, HDCP, setting an EDID, storing and deleting one, Revert, and paste.

With a command line test: several routes in one command, unrouting, a route to a locked output, renaming, and the router's announcement of a route changed elsewhere and of cables being unplugged.

Mute and hotplug, with a command line test: muting and unmuting inputs and outputs, several in one command, a mute staying through a route change, a locked output refusing to mute, and `U` for a locked and muted output. Hotplug on Input 1 with a MacBook and on Output 1 with a display, timed from the router's status.

Input locks on the MX2-8X8-HDMI20-AUDIO, with a command line test: locking and unlocking, the routes, unroutes and mutes it refuses, and its announcement.

Router presets, with a command line test: creating, saving, copying, renaming and deleting, the forms each needs, the errors for a name in use and a missing preset, and which subscription hears each announcement. Writing a preset's routes directly, and loading one written that way, and the front-panel preset slots.

Standby, with a command line test: entering and leaving it, its announcement, the refusal of routes, names, locks, mutes and HDCP while in it, and how long signals took to come back.

Connections, on firmware 1.11.3b5, with the router on a cable to the test machine alone: 15 at once, TCP and WebSockets together. Any more were refused straight away and those already open kept working, the module's included. A WebSocket closed by the browser held its place for about 50 seconds.
