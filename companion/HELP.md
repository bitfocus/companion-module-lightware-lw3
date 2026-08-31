## Lightware 3

This module is for controlling Lightware equipment that supports the LW3 protocol.

On connect the module asks the device which paths it provides, rather than assuming them from the model
name, so it adapts to both older and newer firmware generations. Devices that do not expose a video
crosspoint at all are reported in the log; please open an issue if your LW3 compatible equipment is not
supported.

### Configuration

- Type in the IP address of the device.
- The device will use port 6107.
- "Log protocol traffic" writes every command and response to the log. Leave it off unless you are
  troubleshooting, as a large matrix produces a lot of lines.

### Actions

- Switch - Route video input to output
- Select source and destination - just select inputs and outputs for routing them with the 'Route selected ports' action
- Route selected ports - make tie between selected ports
- Preset - Recall a preset
- Output Lock / Input Lock - lock, unlock or toggle the lock of a port (only available if your device
  provides the lock methods). Toggling needs the device to report the port status, so it does nothing
  until the current lock state is known
- Run Macro (only available if there are macros)
- Switch USB Host (only available if your matrix has USB switching capability)
- Soft Reset Device

### Feedbacks

- Route - Shows if a given source is routed to a given output or selected port
- selected Source and Destination - Shows the currently selected ports for the 'Route selected ports' action
- input locked / output locked - Shows if a port is locked on the device

### Variables

- name_I1 or name_O1 - The name of the input or output port, the number counts up to the number of available ports
- source_O1 - The input currently routed to output 1, the number counts up to the number of available ports
- sourcename_O1 - The name of the input currently routed to output 1, the number counts up to the number of available ports

### Presets

- Presets are available for selection of all inputs and outputs your matrix supports. You can use them to make routes with two or three button pushes.  
  With two pushes use: 1. Select Output, 2. Select and Take Input  
  with three pushes use: 1. Select Output or Select Input, 2. Select Input or Select Output, 3. Take selected  
  The presets for selecting and switching crosspoints make the buttons act very similar to an X/Y salvo panel. Color feedbacks show active routes and selections as background and tet colors. It is more difficult to explain then in reality, so just play with it and you'll get it.
