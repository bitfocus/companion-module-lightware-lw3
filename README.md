# companion-module-lightware-lw3

See HELP.md and LICENSE

# Version History

## v2.1.0

Tested against an MX2-16x16-HDMI20-R, which none of the previous releases could drive.

- Major: rewrite for the Companion module API 2.0 (`@companion-module/base` v2, node22 runtime, `src/` layout)
- Feat: the device is asked which paths and properties it provides instead of matching against a list of
  product names. The crosspoint node, the name of its routing property, the source of the port names and
  the preset style are each detected independently, so models and firmware revisions that were previously
  unrecognised are supported
- Feat: presets stored on the device get a ready made button each, under "Recall Preset"
- Feat: Input Lock action, alongside the existing Output Lock, both with a toggle option
- Feat: feedbacks for the lock state of an input or an output
- Feat: the lock actions and feedbacks pick their port from a named dropdown instead of a port number.
  An upgrade script moves existing Output Lock buttons over
- Bugfix: the response parser was not reset when the helper reconnected, so a connection lost in the
  middle of a multi line response left it waiting for a closing brace and swallowing every later reply
- Bugfix: a command that could not be sent left its response handler behind forever
- Feat: optional "Log protocol traffic" setting logs the raw LW3 exchange for troubleshooting
- Bugfix: actions with device supplied dropdowns were discarded by Companion, so most of the module's
  actions never appeared in the actions list (#41). Dropdowns are never registered empty now
- Bugfix: config field used the unsupported type `text`, which newer Companion versions reject with
  "Unsupported field type text"
- Bugfix: firmware that reports `DestinationConnectionStatus` instead of `DestinationConnectionList` left
  the module without any routing information (#15)
- Bugfix: unrecognised devices mixed up the two crosspoint path styles, which left them unusable (#45)
- Bugfix: port names and presets were only read when crosspoint detection succeeded, so one unsupported
  path silently disabled sources, destinations and presets together
- Bugfix: `-E` error responses were parsed as valid data, and error detection never triggered at all, so
  a failed request could stall the response parser
- Bugfix: rename notifications were requested with a wildcard the device rejects, so renaming a port on
  the device never reached Companion
- Bugfix: an unconnected output reported as `0` is no longer treated as a malformed connection status
- Bugfix: renaming a preset on the device corrupted the preset list instead of updating the entry
- Bugfix: trailing spaces in port names reported by the device are trimmed

## v2.0.6 (2025-04-21)

- Change type for the Info field in config settings

## v2.0.4 (2023-06-26)

- Feat: added soft reset action

## v2.0.3 (2023-06-08)

- Bugfix: fixed readback of the internal matrix presets for MX2. This bug was preventing the module to load with MX2.
- Bugfix: fixed feedback 'route' for MX2

## v2.0.2 (2023-05-26)

- Bugfix: make actions working again
- Bugfix: make feedbacks working again
- Bugfix: make presets morking again
- Bugfix: make special MX actions working again
- Bugfix: show Macro action even if currently no macros are available
- Bugfix: don't throw error when feedbacks are checked for a larger matrix then currently connected
- Bugfix: removed lodash

## v2.0.1 (2023-05-14)

- Added lodash

## v2.0.0 (2023-05-14)

- Major: rewrite for Companion v3 compatibility
- Known Bugs: nothing is working, except the route crosspoint action

## v1.1.0 (2022-12-04)

- Feat: added actions for selecting and routing inputs and outputs like on a X/Y panel
- Feat: added output lock action
- Feat: added load preset action
- Feat: added run macro action
- Feat: added switch USB host action for MX2-8x8-USB
- Feat: added feedbacks for crosspoint status
- Feat: added variables for input and output names
- Feat: refactor code to ES6 format

## v1.0.2 (2022-02-02)

- Brush: replaced system.emit calls

## v1.0.1 (2020-03-12)

- Change: changed module name from lightware3 to lightware-lw3

## v1.0.0 (2018-07-03)

- Initial release
