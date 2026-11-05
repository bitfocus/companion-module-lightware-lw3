Version 3.0.0 is a rewrite, built from measurements of one router, an MX2-8x8-HDMI20-L on firmware 1.10.1b4, and tested with it on Companion 5.1.1. Other models may have different LW3 paths, and they have not been tested. If yours isn't supported, the log says so.

## SETUP

Enter the router's IP address. LW3 uses TCP port 6107, which is the default.

## HOW IT WORKS

The module learns the router's size, port names, routes, locks, port status and presets when it connects, and again after every reconnect. After that the router announces changes, including those made from its front panel or web interface, so they appear straight away. There is no polling.

If a preset added or changed on the router doesn't appear, disable and enable the connection to read it again. Its name can also be typed into the action.

The connection is tested every 3 seconds, as the router says nothing while nothing changes. If the router doesn't answer within 3 seconds the module reconnects, and keeps trying every 5 seconds until the router returns. Unplugging a network cable should therefore show within about 6 seconds.

### Routing

Select an output and an input, in either order, then press TAKE. The selection clears once the router accepts the route, and stays if the router refuses it. A selected input flashes while taking it would change the output's route.

On the output button that shows its routed input, the selected input appears below as `v [name]` until you take it, so you can see what's about to change. Staged routes show the same way, in orange.

Press an output and the input on it lights up. Press an input and every output carrying it lights up.

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

### Locked outputs

A route to a locked output is refused by the router, and the log says so.

### Port status

**Signal on a port** and **Cable connected to a port** come from the router's own port status. On an output, signal means a live input is routed to it, not that a display is there: use **Cable connected** for that.

### Port names, EDID and HDCP

Open `/instance/<connection label>/` at this Companion's web address, which the connection settings also show. It's one page with two tables, read fresh from the router each time it opens or you press Reload.

The page shows **Live** while it's listening to the router itself, so changes made elsewhere appear as they happen, and it says so on the row. If you're editing that cell your edit stays, with a note of what the router now has. **Not live** means this browser can't reach the router directly, or the router has run out of connections, as Lightware's devices limit how many WebSockets they allow. Everything else still works, but press Reload to see changes. The router never announces stored EDIDs, so they are read again when you click the filter box.

Change as many ports as you like, then press **Apply**. It lists what will change and asks first. If anything is wrong with any row, nothing is sent. Each row then shows what the router kept. **Revert last Apply** fills the old values back in, and **Copy all** gives you a table to paste into a spreadsheet.

You can paste from a spreadsheet into a Name cell: lines fill downward, and tabs fill across. A line starting with a port, such as `I3`, goes to that port. Blank cells are left alone.

- **Names** can be up to 62 plain characters, as the router mangles accents and emoji. What you type stays in the cell, with a note of what will be sent: `Café` is sent as `Cafe`, and emoji are removed. Apply lists it too. The **Rename a port** action does the same.
- **EDID** offers what the router holds. The filter box narrows the lists: spaces mean "and", so `3840 p60` finds names with both. An input's current EDID stays listed whatever the filter says. F is factory, U is stored by you and D is dynamic, which follows the last display seen on that output and can change by itself, so it shows orange.
- **HDCP** on an input is the maximum it offers: Off, HDCP 2.2 or HDCP 2.2 Strict. On an output, Always encrypts everything, and Auto follows the input.
- **Stored EDIDs** copies any EDID into a U slot, or deletes one.

EDID and HDCP changes can make sources and displays renegotiate, which can drop their picture. The page warns you, and says which of the changed inputs have a live signal.

### Soft reset

The **Soft reset the router** action restarts the router. There is deliberately no preset for it.

## LOG

The log shows what was found on connecting, reconnects, routes, names and locks changed from elsewhere, and anything the router refuses. Signal and cable changes are at debug level, along with any line from the router the module doesn't recognise.

## VARIABLES

- `name_I1`, `name_O1`: port names
- `source_O1`: the input on output 1, such as `I3`, or `0` for none
- `sourcename_O1`: that input's name, or `None`
- `stagedname_O1`: the name of the input staged for output 1
- `live_preset`: a router preset matching the current routes, or `None`
- `selected_input_label`, `selected_output_label`, `selected_output_source`, `selected_output_lock_text`: for button text
- `model`, `firmware`, `inputs`, `outputs`
