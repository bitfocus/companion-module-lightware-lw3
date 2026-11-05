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
- **feat(routing):** new **Unroute an output** action.
- **feat(routing):** route changes made elsewhere, such as from the front panel or web interface, appear straight away and are logged. The module relies on the router's change messages and doesn't poll.
- **feat(presets):** new **Router preset is live** feedback and `live_preset` variable show when the router's routes match a preset. Presets stored on the router get a button each.
- **feat(presets):** with auto-route on Stage, a router preset's routes are staged instead of loaded, so what it would change shows before anything changes. Only the routes that would change are sent when taken. New **Router preset is staged** feedback.
- **feat(routing):** with auto-route on Stage, clearing a route is staged with the others.
- **feat(presets):** a router preset's name can be typed into its action while the router is offline.
- **feat(lock):** the lock action works on MX2 routers, can toggle, can act on the selected output, and has a preset. New **Locked output** feedback.
- **feat(status):** new **Signal on a port**, **Cable connected to a port** and **Port status** feedbacks. Input and output presets show a coloured border with the legend from the router's web interface.
- **feat(ports):** a page at `/instance/<connection label>/` to edit names, EDID and HDCP for all ports together, with a confirmation listing the changes, all-or-nothing checks, paste from a spreadsheet, Revert and Copy all. It also stores and deletes EDIDs in U slots. EDID changes go out as one command.
- **feat(ports):** the page updates live from the router's WebSocket, keeps anything being edited, and shows whether it is Live. Names with accents or emoji are sent as the nearest plain characters, and EDID lists can be filtered.
- **feat(ports):** the page is titled with the router's name, and can change it. New `router_name` variable.
- **feat(names):** new **Rename a port** action. Names changed elsewhere appear straight away and are logged.
- **feat(presets):** presets use Companion 5 layered buttons with a plain fallback, a blank styled button, and every button lights up while held.
- **feat(log):** logs what was found on connecting, reconnects, changes made elsewhere and anything the router refuses.
- **feat(connection):** a lost connection is noticed within about 6 seconds without pressing anything, and the module keeps retrying until the router returns.
- **feat(tools):** `tools/lw3-capture.mjs` reads a router's whole LW3 tree without changing anything, and `yarn fake-router` runs a fake one.

### Bug Fixes

- **fix(routing):** routes are read from `DestinationConnectionStatus`, which is what this router has. v2 only asked for `DestinationConnectionList`, so route feedback was wrong until something changed.
- **fix(routing):** an output with nothing routed shows `None`, not a blank.
- **fix(presets):** a reply without presets no longer throws an error while reading them.
- **fix(errors):** errors from the router are now noticed. v2's check for them could never match.
- **fix(lock):** the lock action looked for a path MX2 routers don't have, so it never appeared on them.

### Not tested

- Soft reset.
- How many routes one command can hold, which matters for a staged preset on a big router.
- Whether the router announces a preset being saved, added or removed, and whether it announces a lock changed elsewhere.
- Any router other than the MX2-8x8-HDMI20-L, any other firmware, and any other version of Companion.
- Upgrading a v2 configuration.
- How many WebSockets and subscriptions a router allows. The ports page subscribes per port, so 96 on a 48x48.
- The ports page's WebSocket against the fake router, which has none by design.

### Tested on hardware

In Companion 5.1.1, and again after moving to Node 26 on Companion 5.1.2 (routing, TAKE, status borders, the ports page and the built package): recalling router presets, the live preset feedback, toggling locks, the auto-route modes, staging router presets, staged clears, a route and a clear in one command, and a locked output staying staged while the rest of a preset is taken. The ports page was tried on spare ports: names including `( ) # %`, HDCP, setting an EDID, storing and deleting one, Revert, and paste.

With a command line test: several routes in one command, unrouting, a route to a locked output, renaming, and the router's announcement of a route changed elsewhere and of cables being unplugged.
