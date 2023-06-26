# companion-module-lightware-lw3
See HELP.md and LICENSE

# Version History

## v2.0.4 (2023-06-26)
* Feat: added soft reset action

## v2.0.3 (2023-06-08)
* Bugfix: fixed readback of the internal matrix presets for MX2. This bug was preventing the module to load with MX2.
* Bugfix: fixed feedback 'route' for MX2

## v2.0.2 (2023-05-26)
* Bugfix: make actions working again
* Bugfix: make feedbacks working again
* Bugfix: make presets morking again
* Bugfix: make special MX actions working again
* Bugfix: show Macro action even if currently no macros are available
* Bugfix: don't throw error when feedbacks are checked for a larger matrix then currently connected
* Bugfix: removed lodash

## v2.0.1 (2023-05-14)
* Added lodash

## v2.0.0 (2023-05-14)
* Major: rewrite for Companion v3 compatibility
* Known Bugs: nothing is working, except the route crosspoint action

## v1.1.0 (2022-12-04)
* Feat: added actions for selecting and routing inputs and outputs like on a X/Y panel
* Feat: added output lock action
* Feat: added load preset action
* Feat: added run macro action
* Feat: added switch USB host action for MX2-8x8-USB
* Feat: added feedbacks for crosspoint status
* Feat: added variables for input and output names
* Feat: refactor code to ES6 format

## v1.0.2 (2022-02-02)
* Brush: replaced system.emit calls

## v1.0.1  (2020-03-12)
* Change: changed module name from lightware3 to lightware-lw3

## v1.0.0 (2018-07-03)
* Initial release