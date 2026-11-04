# companion-module-lightware-lw3

Controls Lightware matrix routers over LW3 from [Bitfocus Companion](https://bitfocus.io/companion). See [HELP.md](companion/HELP.md) for how to use it, [CHANGELOG.md](CHANGELOG.md) for what changed and [LICENSE](LICENSE) for the licence.

## Tested

Built from measurements of an MX2-8x8-HDMI20-L on firmware 1.10.1b4, and tested with it on Companion 5.1.1. See the "Not tested" section of the [changelog](CHANGELOG.md).

## Developing

This uses Yarn 4 through Corepack, and Node 22.20 or newer.

```bash
corepack enable
yarn install
yarn build
yarn test
```

To try the module without a router, run `yarn fake-router` and point a connection at `127.0.0.1`.

## Reading a router

LW3 varies between models, so the module is built on what real routers do. Lightware's manual text can be wrong: this router's own text gives `switch(I1,O1)`, and it rejects that.

`node tools/lw3-capture.mjs ROUTER_IP` walks a router's whole LW3 tree and saves it in `captures/`. It only sends `GET` and `MAN`, so it can't change anything.

`node tools/lw3-try.mjs ROUTER_IP` tests routing, locks and names on two outputs with no display. **This one changes the router.** It reports where it left things.

Captures stay out of git because they can hold port names and stored EDIDs.
