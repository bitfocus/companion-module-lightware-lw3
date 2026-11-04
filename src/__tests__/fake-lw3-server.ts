/**
 * A fake router to try the module without hardware. Run `yarn fake-router`, then point a Companion
 * connection at 127.0.0.1 on the port it prints. Use another port with `yarn fake-router 6108`.
 */
import { FakeLw3 } from './fake-lw3.js'

const requested = Number(process.argv[2])
const fake = new FakeLw3()
fake.routes.splice(0, 8, 1, 2, 2, 1, 0, 2, 0, 2)
fake.setSignal('I1', true, true)
fake.setSignal('O1', true, true)

const port = await fake.listen(Number.isInteger(requested) && requested > 0 ? requested : 6107)
console.log(`Fake LW3 router listening on 127.0.0.1:${port}. Press Ctrl-C to stop.`)

// routes change on their own now and then, as if from the front panel, to show changes made elsewhere
setInterval(() => {
	const output = 5 + Math.floor(Math.random() * 4)
	const input = Math.floor(Math.random() * 9)
	if (fake.outputs[output - 1].locked) return
	fake.routeFromPanel(input, output)
	console.log(`Output ${output} now on ${input === 0 ? 'nothing' : `input ${input}`}`)
}, 20000)
