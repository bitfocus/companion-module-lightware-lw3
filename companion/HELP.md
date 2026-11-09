Version 3.0.0 is a rewrite, built from measurements of an MX2-8x8-HDMI20-L on firmware 1.10.1b4, and tested on Companion 5.1.2 with it, with an MX2-8X8-HDMI20-AUDIO on the same firmware, with an MX2-16x16-HDMI20-R on firmware 1.11.3b5, and with an MX2-24x24-HDMI20-R on firmware 1.12.0b8. Other models may have different LW3 paths, and they have not been tested. If yours isn't supported, the log says so.

## SETUP

The connection settings say which router it's connected to, with its model, firmware and size.

Enter the router's IP address. LW3 uses TCP port 6107, which is the default.

## HOW IT WORKS

The module learns the router's size, port names, routes, locks, port status and presets when it connects, and again after every reconnect. After that the router announces changes, including those made from its front panel or web interface, so they appear straight away. There is no polling.

If a preset added or changed on the router doesn't appear, disable and enable the connection to read it again. Its name can also be typed into the action.

The connection is tested every 3 seconds, as the router says nothing while nothing changes. If the router doesn't answer within 3 seconds the module reconnects, and keeps trying every 5 seconds until the router returns. Unplugging a network cable should therefore show within about 6 seconds.

### Routing

Select an output and an input, in either order, then press TAKE. The selection clears once the router accepts the route, and stays if the router refuses it. A selected input flashes while taking it would change the output's route.

On the output button that shows its routed input, the selected input appears below as `v [name]` until you take it, so you can see what's about to change. Staged routes show the same way, in orange.

Press an output and the input on it lights up. Press an input and every output carrying it lights up.

**Hold an input for a second to send it to every output.** With auto-route on Cut, every output changes straight away, in one command. On Off or Stage, they're staged, and TAKE sends them. Locked outputs are left as they are, and the log says which. So that a hold doesn't also select, input buttons select when you let go of a short press, rather than as you press. The **Route an input to every output** action does the same from a button of your own.

Take care with a hold on Cut: it changes every display at once, and nothing on the button warns you.

To change several routes together, set auto-route to Stage, press an input and then its outputs, and press a new input to start a new pair. TAKE changes to TAKE STAGED and flashes while routes are waiting, and sends them as one command so the router changes them together. Staged routes belong to the module, not the router, and are lost when the module restarts. A locked output keeps its staged route and the log says so.

### Auto-route

"When an input and an output are both selected" in the connection settings, or the AUTO button, decides what a selected pair does:

- **Off** waits for TAKE.
- **Cut** takes as soon as both are selected.
- **Stage** stages as soon as both are selected, so a salvo is built by pressing an input and then its outputs. CLEAR XPT and router preset buttons stage too, instead of acting straight away.

The mode is saved in the connection settings, and changing it never routes anything by itself. Leaving Stage discards anything staged, and the log lists what was dropped.

CLEAR STAGED discards staged routes. In Stage it also clears the selection. In Off it only clears a selected pair that was staged.

### Router presets

These are the presets stored on the router, shown under Router presets. **Router preset is live** lights a button while the router's routes are the same as that preset's, whichever way they got there, so two presets with identical routes both light up.

With auto-route on Stage, pressing a router preset shows what it would do before anything changes. Outputs it would change turn orange and show their staged input, and the preset button turns orange. TAKE makes the changes, or CLEAR STAGED discards them. Pressing another preset replaces what was staged.

A staged preset only changes routes. Anything else a preset holds is only applied by recalling it with auto-route on Off or Cut.

If the router is offline when you build a button, type the preset's name into the action.

Presets added, renamed or deleted elsewhere, such as on the router's web page, appear straight away.

#### Saving router presets

A save stores what is routed now. With routes staged, it stores what a take would leave instead: the staged routes, and the current ones everywhere else. Nothing is routed by saving.

- **SAVE PRESET button:** press it, and it, every router preset button, and the inputs that have a front-panel preset all flash red. Within 5 seconds, press a router preset to overwrite it, or an input to save to that front-panel preset button, as the router's own front panel does. An empty front-panel button gets a new preset called `Button1` and so on. Pressing SAVE again, or anything else, cancels.
- **Overwrite a router preset** action: for a button of your own. There is no one-press preset for it, as the old routes are lost.
- **Create a router preset** action: makes a new preset from the current routes. Names can use up to 46 letters, digits, `-` and `_`. The router allows more, but those would end up inside commands.
- **Front-panel presets:** the router has preset buttons on its front panel, and the module has a button for each, under Router presets. Each shows the name of the preset it holds, or `EMPTY` with the name SAVE would give it, recalls it, and follows any change made on the router. Place them once, and a preset saved with SAVE and an input appears on them by itself.
- **Tip:** for presets you'll keep on a surface, save them to front-panel preset buttons and place those. They keep up when a preset is renamed. A named router preset button doesn't, because to Companion a renamed preset is a new one, so it would need placing again.
- **Ports page:** the Router presets table shows each preset's routes, and has Save, Rename, Copy and Delete for each, and a box to create one. Each asks first.

### Locks

The router can lock inputs as well as outputs.

- **A locked output** keeps its route.
- **A locked input** can't be routed anywhere new, and every output showing it is frozen too. The router marks only the input, so its web interface makes those outputs look free. The module shows them as locked.

**LOCK** acts on the input or output pressed last, as MUTE does, and turns red while it's locked. Locked inputs and outputs turn red too. The **Lock or unlock a port** action can also name a port, and the older output lock action still works. A route, take or staged preset leaves out whatever a lock would stop, and the log says which lock. A locked port can't be muted or unmuted either. Locks made elsewhere are logged.

### Mute

A muted port stays routed and sends black, without dropping its signal, so the display stays in sync. Muting an input blacks every output it feeds. That makes a mute different from **CLEAR XPT**, which removes the route.

The **MUTE** button acts on the input or output pressed last, and turns blue while it's muted. Input and output buttons turn blue too. The **Mute or unmute a port** action can also name a port.

### Hotplug

A hotplug makes a port look unplugged for a moment, from the module or the ports page, without reaching into the rack.

- **Output:** turns its 5V off, then on, which can wake a display that has lost its picture. Only that output is affected. The **HOTPLUG** button acts on the selected output and turns orange while it's off.
- **Input:** turns its hotplug signal off, then on, so the source reads the EDID again, such as after a change to an EDID from the same maker that it didn't notice. Every output the input feeds drops its picture too, so this is an action with no button, and the ports page lists those outputs before it goes ahead. If the source fakes its own EDID, it does nothing useful.

Each is off for 2 seconds unless the action says otherwise. On the MX2-8x8-HDMI20-L the router saw a display come back about half a second after its 5V came back on, and an input's source had its signal back about 3 seconds after its hotplug came back on. A port that is already off, set that way on purpose, is left alone. If the connection drops part way, the port is turned back on when the router is back.

The router can see a display being detected, but not a picture, so whether a hotplug worked is for your eyes to judge.

### Port status

Input and output buttons have a coloured border, in the colours of the router's own web interface:

- **No border:** not connected
- **Yellow:** connected, no signal
- **Orange:** DVI signal
- **Light blue:** HDMI signal, up to 9G
- **Dark blue:** HDMI signal, up to 18G

An output with no display shows no border even with a source routed to it, as the router's interface does. The plain fallback buttons have no border. DisplayPort has its own legend in the router's interface, which the module doesn't show yet. The **Port status** feedback gives you the same states for your own buttons.

**Signal on a port** and **Cable connected to a port** come from the router's own port status. On an output, signal means a live input is routed to it, not that a display is there: use **Cable connected** for that.

### Port names, EDID and HDCP

Use the link in the connection settings, or add `/instance/<connection label>/` to this Companion's web address. It's one page, titled with the router's name, with two tables, read fresh from the router each time it opens or you press Reload.

The page shows **Live** while it's listening to the router itself, so changes made elsewhere appear as they happen, and it says so on the row. If you're editing that cell your edit stays, with a note of what the router now has. **Not live** means this browser can't reach the router directly, or the router has run out of connections. The MX2-8x8-HDMI20-L allows 15 at once, shared between its web interface, open ports pages, this module and anything else using LW3, and refused any more. A page or web interface closed in the browser kept its place for about 50 seconds afterwards. If the module itself can't get a connection for this reason, its log and status say the router may be full, and it keeps retrying. Everything else still works, but press Reload to see changes. The router never announces stored EDIDs, so they are read again when you click the filter box.

Change as many ports as you like, then press **Apply**. It lists what will change and asks first. If anything is wrong with any row, nothing is sent. Each row then shows what the router kept. **Revert last Apply** fills the old values back in, and **Copy all** gives you a table to paste into a spreadsheet.

You can paste from a spreadsheet into a Name cell: lines fill downward, and tabs fill across. A line starting with a port, such as `I3`, goes to that port. Blank cells are left alone.

- **Router name** can be up to 39 plain characters. It's also in the `router_name` variable.
- **Names** can be up to 62 plain characters, as the router mangles accents and emoji. What you type stays in the cell, with a note of what will be sent: `Café` is sent as `Cafe`, and emoji are removed. Apply lists it too. The **Rename a port** action does the same.
- **EDID** offers what the router holds. The filter box narrows the lists: spaces mean "and", so `3840 p60` finds names with both. An input's current EDID stays listed whatever the filter says. F is factory, U is stored by you and D is dynamic, which follows the last display seen on that output and can change by itself, so it shows orange.
- **HDCP** on an input is the maximum it offers: Off, HDCP 2.2 or HDCP 2.2 Strict. On an output, Always encrypts everything, and Auto follows the input.
- **Stored EDIDs** copies any EDID into a U slot, or deletes one.

EDID and HDCP changes can make sources and displays renegotiate, which can drop their picture. The page warns you, and says which of the changed inputs have a live signal.

### Standby

The router's standby turns every output off, and it refuses any change until it wakes. The **Put the router in standby, or wake it** action does either, or toggles. There is deliberately no preset for it.

While the router is in standby, wherever that was done from, the connection shows a warning, the log says so, the `power` variable is `STANDBY`, the **Router in standby** feedback is on, and the ports page says so at the top. On the MX2-8x8-HDMI20-L, signals took about 20 seconds to come back after waking.

### Soft reset

The **Soft reset the router** action restarts the router. There is deliberately no preset for it.

## LOG

The log shows what was found on connecting, reconnects, routes, names, locks and mutes changed from elsewhere, hotplugs, and anything the router refuses. Signal and cable changes are at debug level, along with any line from the router the module doesn't recognise.

## VARIABLES

- `name_I1`, `name_O1`: port names
- `source_O1`: the input on output 1, such as `I3`, or `0` for none
- `sourcename_O1`: that input's name, or `None`
- `stagedname_O1`: the name of the input staged for output 1
- `live_preset`: a router preset matching the current routes, or `None`
- `selected_input_label`, `selected_output_label`, `selected_output_source`, `selected_output_lock_text`, `selected_lock_text`, `selected_mute_text`, `selected_output_hotplug_text`: for button text
- `model`, `router_name`, `firmware`, `inputs`, `outputs`
