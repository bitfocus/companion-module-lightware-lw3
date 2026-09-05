const { TCPHelper } = require('@companion-module/base')

// LW3 responses are prefixed with a two character code. The second character 'E'
// marks an error (nE/pE/mE for node/property/method, -E for a malformed command),
// 'mF' marks a failed method call.
// See the LW3 programmers' reference, "Prefix summary".
const LW3_ERROR_PREFIX = /^([npm-]E|mF)/

function isErrorResponse(result) {
	return typeof result !== 'string' || result === '' || LW3_ERROR_PREFIX.test(result)
}

/**
 * The first character of a crosspoint port status code carries the mute and lock
 * state: T normal, M muted, L locked, U muted and locked. Confirmed on an
 * MX2-16x16-HDMI20-R, where locking a port changed "TAF" to "LAF".
 * The remaining characters describe the signal and are not interpreted here.
 */
const LOCKED_STATES = ['L', 'U']
const MUTED_STATES = ['M', 'U']

function parsePortStatusList(line) {
	const values = line.replace(/^.+PortStatus=/, '').split(';')
	if (values[values.length - 1] === '') values.pop()
	return values
}

function statusFlag(code, states) {
	if (typeof code !== 'string' || code.length < 1) return undefined
	return states.includes(code.charAt(0))
}

function isStatusLocked(code) {
	return statusFlag(code, LOCKED_STATES)
}

function isStatusMuted(code) {
	return statusFlag(code, MUTED_STATES)
}

module.exports = {
	/**
	 * Logs the raw protocol exchange when the user enables it in the connection
	 * config. Logged at 'warn' so it shows up without changing the log level.
	 */
	trace(message) {
		if (this.config?.verbose) this.log('warn', `[trace] ${message}`)
	},

	/**
	 * Drops everything left over from a previous connection. The helper reconnects
	 * on its own without re-running initTCP, so a drop in the middle of a multi
	 * line response would otherwise leave the parser waiting for a closing brace
	 * that never comes, swallowing every later response.
	 */
	resetParserState() {
		this.pstate = this.PSTATE_READY
		this.pid = ''
		this.multiline = ''
		this.multilineError = ''
		// Anything still pending belongs to the connection that just went away
		this.responseHandlers = {}
		this.sendId = 0
	},

	initTCP() {
		let instance = this
		let receivebuffer = ''
		this.resetParserState()

		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}
		if (!this.config.host) {
			this.log('error', 'No device IP configured')
			return
		}
		{
			this.trace(`connecting to ${this.config.host}:6107`)
			this.socket = new TCPHelper(this.config.host, 6107)

			this.socket.on('status_change', (status, message) => {
				instance.trace(`socket status: ${status}${message ? ' - ' + message : ''}`)
				instance.updateStatus(status, message)
			})

			this.socket.on('connect', () => {
				instance.trace('socket connected, querying device')
				receivebuffer = ''
				instance.resetParserState()
				try {
					instance.initDevice()
				} catch (error) {
					instance.log('error', `initDevice failed: ${error.stack || error.message}`)
				}
			})

			this.socket.on('error', (err) => {
				instance.log('error', 'Network error: ' + err.message)
			})

			this.socket.on('data', (chunk) => {
				let i = 0,
					line = '',
					offset = 0
				receivebuffer += chunk

				while ((i = receivebuffer.indexOf('\r\n', offset)) !== -1) {
					line = receivebuffer.substring(offset, i)
					offset = i + 2
					this.socket.emit('receiveline', line.toString())
				}
				receivebuffer = receivebuffer.slice(offset)
			})

			this.socket.on('receiveline', (line) => {
				instance.trace(`<< ${line}`)
				if (instance.pstate === instance.PSTATE_READY && line.startsWith('{')) {
					instance.pstate = instance.PSTATE_MULTILINE
					instance.multiline = ''
					instance.multilineError = ''
					instance.pid = line.slice(1)
				} else if (instance.pstate === instance.PSTATE_MULTILINE) {
					if (line === '}') {
						const pid = instance.pid
						const handler = instance.responseHandlers[pid]
						// An unsupported path is a normal outcome while probing what this
						// firmware offers, so the error text is handed to the callback
						// rather than being reported as a module failure. isError tells an
						// empty-but-valid response (a node with no children) apart from a
						// rejected one.
						const isError = instance.multilineError.trim() !== ''
						const payload = isError ? instance.multilineError.trim() : instance.multiline.trim()

						delete instance.responseHandlers[pid]
						instance.pstate = instance.PSTATE_READY

						if (handler !== undefined) {
							try {
								handler(payload, isError)
							} catch (error) {
								instance.log('error', `Error while processing response from device: ${error.message}`)
							}
						}
					} else {
						if (LW3_ERROR_PREFIX.test(line)) {
							instance.multilineError += line + '\r\n'
						} else {
							instance.multiline += line + '\r\n'
						}
					}
				} else {
					try {
						this.parseResponse(line)
					} catch (error) {
						this.log('error', `Error while parsing response from device: ${error.message}`)
					}
				}
			})
		}
	},

	initDevice() {
		this.sendCommand('GET /.ProductName', (result) => {
			if (isErrorResponse(result)) {
				this.log('warn', 'Device did not report a product name')
				return
			}
			this.log('info', 'Connected to an ' + result.replace(/^.+ProductName=/, ''))
		})

		// Each of these is independent: a device that hides one of them must still
		// get everything else it does support.
		this.detectCrosspoint()
		this.detectPortNames()
		this.detectPresets()
		this.detectOptionalActions()
	},

	/**
	 * Locates the video crosspoint node. Both the node path and the name of the
	 * property holding the routing table differ between models and firmware
	 * generations, so the node is asked for its properties rather than guessing:
	 * some devices report DestinationConnectionList, others DestinationConnectionStatus.
	 */
	detectCrosspoint() {
		const paths = ['/MEDIA/XP/VIDEO', '/MEDIA/VIDEO/XP']

		const probe = (index) => {
			if (index >= paths.length) {
				this.log('error', 'Could not find a video crosspoint on this device. Routing actions are unavailable.')
				return
			}
			const path = paths[index]
			this.sendCommand(`GET ${path}.*`, (result) => {
				if (isErrorResponse(result)) {
					probe(index + 1)
					return
				}

				const lines = result.split(/\r\n/)
				const routingLine = lines.find((line) => /\.DestinationConnection(List|Status)=/.test(line))
				if (!routingLine) {
					this.log(
						'debug',
						`${path} exists but has no DestinationConnectionList/Status property. Properties were:\n${result}`,
					)
					probe(index + 1)
					return
				}

				this.xpPath = path
				this.xpProperty = routingLine.match(/\.(DestinationConnection(?:List|Status))=/)[1]
				this.log('info', `Using video crosspoint at ${path}.${this.xpProperty}`)

				this.sendCommand(`OPEN ${path}`, () => {})
				// Feed every property through the same parser the change notifications
				// use, so the initial state and later updates are handled identically.
				lines.forEach((line) => this.parseResponse(line))
				this.checkFeedbacks('route')

				this.detectLockSupport(lines)
			})
		}

		probe(0)
	},

	/**
	 * Reads the input and output labels. Older devices expose them below
	 * /MEDIA/VIDEO/<port>.Text, newer ones below /MEDIA/NAMES/VIDEO.
	 */
	detectPortNames() {
		const sources = [
			{
				command: 'GET /MEDIA/VIDEO/*.Text',
				subscribe: 'OPEN /MEDIA/VIDEO/*.Text',
				pattern: /\/MEDIA\/VIDEO\/(.+?)\.Text=(.+)$/,
			},
			{
				command: 'GET /MEDIA/NAMES/VIDEO.*',
				// A wildcard is rejected here with a syntax error; the node itself must
				// be subscribed to for rename notifications to arrive.
				subscribe: 'OPEN /MEDIA/NAMES/VIDEO',
				pattern: /\/MEDIA\/NAMES\/VIDEO\.(.+?)=\d+;(.+)$/,
			},
		]

		const probe = (index) => {
			if (index >= sources.length) {
				this.log('error', 'Could not read the port names from this device.')
				return
			}
			const source = sources[index]
			this.sendCommand(source.command, (result) => {
				if (isErrorResponse(result)) {
					probe(index + 1)
					return
				}

				if (this.applyPortNames(result, source.pattern) === 0) {
					probe(index + 1)
					return
				}

				this.sendCommand(source.subscribe, () => {})
				// The routing table usually arrives before the names do, so the resolved
				// source names are filled in once the names are known.
				this.updateSourceNames()
				this.initActions()
				// The lock feedbacks pick their ports from the same lists as the actions
				this.initFeedbacks()
				this.initVariables()
				this.updatePresets()
			})
		}

		probe(0)
	},

	updateSourceNames() {
		this.setVariableValues(
			Object.fromEntries(
				this.state.destinationConnectionList.map((value, index) => [
					'sourcename_O' + (index + 1),
					this.inputs[value] || '',
				]),
			),
		)
	},

	applyPortNames(result, pattern) {
		const list = result.split(/\r\n/)
		let found = 0

		this.CHOICES_INPUTS.length = 0
		this.CHOICES_OUTPUTS.length = 0

		for (const line of list) {
			const match = line.match(pattern)
			if (!match) continue

			const port = match[1]
			// Names are padded with trailing spaces by some firmware
			const name = match[2].trim()

			if (port.match(/^I\d+$/)) {
				found++
				this.inputs[port] = name
				this.CHOICES_INPUTS.push({ label: name, id: port })
				this.variables['name_' + port] = 'Name of input ' + port.slice(1)
				this.setVariableValues({ ['name_' + port]: name })
			}
			if (port.match(/^O\d+$/)) {
				found++
				this.outputs[port] = name
				this.CHOICES_OUTPUTS.push({ label: name, id: port })
				this.variables['name_' + port] = 'Name of output ' + port.slice(1)
				this.setVariableValues({ ['name_' + port]: name })
				this.variables['source_' + port] = 'Source at output ' + port.slice(1)
				this.variables['sourcename_' + port] = 'Name of source at output ' + port.slice(1)
			}
			if (port.match(/^[IO]\d+$/)) this.createSelectPreset(port)
		}

		return found
	},

	/**
	 * Presets live under different nodes and are recalled with a different method
	 * depending on the firmware, so the style that answered is remembered for the
	 * recall action.
	 */
	detectPresets() {
		this.CHOICES_PRESETS = []

		this.sendCommand('GET /PRESETS/AVC/*.Name', (result) => {
			if (!isErrorResponse(result)) {
				const list = result
					.split(/\r\n/)
					.filter((item) => Array.isArray(item.match(/\/PRESETS\/AVC\/(.+?)\.Name=(.+)$/)))
					.map((item) => {
						const [_all, preset, name] = item.match(/\/PRESETS\/AVC\/(.+?)\.Name=(.+)$/)
						return { id: preset, label: name }
					})
				if (list.length) {
					this.presetStyle = 'AVC'
					this.CHOICES_PRESETS.push(...list)
					this.initActions()
					this.createRecallPresets()
					this.updatePresets()
					return
				}
			}

			this.sendCommand('GET /MEDIA/PRESET', (result, isError) => {
				if (isError) {
					this.log('debug', `This device has no preset node. Response was: ${result}`)
					return
				}

				// The node exists, so this is the style this device uses even when it
				// currently holds no presets.
				this.presetStyle = 'MEDIA'

				const list = result
					.split(/\r\n/)
					.filter((item) => Array.isArray(item.match(/\/MEDIA\/PRESET\/([A-Za-z0-9\-_]{1,16})/)))
					.map((item) => {
						const [_all, preset] = item.match(/MEDIA\/PRESET\/([A-Za-z0-9\-_]{1,16})/)
						return { id: preset, label: preset }
					})
				if (list.length) {
					this.CHOICES_PRESETS.push(...list)
					this.log(
						'info',
						`'GET /MEDIA/PRESET' found ${list.length} presets with the names: ${list.map((i) => i.label).join(', ')}`,
					)
					this.initActions()
					this.createRecallPresets()
					this.updatePresets()
				} else {
					this.log('info', 'No presets are currently stored on this device')
				}
			})
		})
	},

	/**
	 * These actions are only offered when the device actually exposes the matching
	 * paths, which varies by model and firmware.
	 */
	/**
	 * Offered only when the detected crosspoint node actually provides the lock
	 * methods. Built from the property list already fetched during detection.
	 */
	/**
	 * Current lock state of a port, or undefined when the device has not reported
	 * a usable status for it.
	 */
	isPortLocked(direction, port) {
		const list = direction === 'source' ? this.state.sourcePortStatus : this.state.destinationPortStatus
		return isStatusLocked(list?.[port - 1])
	},

	isPortMuted(direction, port) {
		const list = direction === 'source' ? this.state.sourcePortStatus : this.state.destinationPortStatus
		return isStatusMuted(list?.[port - 1])
	},

	detectLockSupport(lines) {
		this.lockSupport = {
			source: lines.some((item) => item.includes(':lockSource')),
			destination: lines.some((item) => item.includes(':lockDestination')),
		}
		this.initActions()
	},

	/**
	 * These actions are only offered when the device actually exposes the matching
	 * paths, which varies by model and firmware.
	 */
	detectOptionalActions() {
		this.sendCommand('GET /MEDIA/USB/USBSWITCH.*', (result) => {
			if (isErrorResponse(result)) return
			const list = result.split(/\r\n/)
			if (!list.find((item) => item.match(/Enable\d+=/))) return

			const hosts = list.filter((item) => item.match(/Enable\d+=/)).map((item) => item.match(/Enable(\d+)=/)[1])
			this.actions['switchUSB'] = {
				name: 'Switch USB Host',
				options: [
					{
						id: 'host',
						type: 'dropdown',
						label: 'Host',
						choices: [
							{ id: '0', label: 'Off' },
							...hosts.map((host) => {
								return { id: host, label: 'PC ' + host }
							}),
						],
						default: '0',
					},
				],
				callback: (action) => {
					this.sendCommand('SET /MEDIA/USB/USBSWITCH.HostSelect=' + action.options.host.toString(), (result) => {
						this.log('info', 'Switch USB Result: ' + result)
					})
				},
			}
			this.setActionDefinitions(this.actions)
		})

		this.sendCommand('GET /CTRL/MACROS.*', (result) => {
			if (isErrorResponse(result)) return
			const noMacrosMessage = 'No macros available'
			const list = result.split(/\r\n/)
			if (!list.find((item) => item.match(/MACROS.\d+=/))) return

			let macros = [noMacrosMessage]
			if (list.find((item) => item.match(/MACROS.\d+=\d+;.+;\w+$/))) {
				macros = list
					.filter((item) => item.match(/MACROS.\d+=\d+;.+;\w+$/))
					.map((item) => item.match(/MACROS.\d+=\d+;.+;(\w+)$/)[1])
			}
			this.actions['runMacro'] = {
				name: 'Run Macro',
				options: [
					{
						id: 'macro',
						type: 'dropdown',
						label: 'Macro',
						choices: macros.map((macro) => {
							return { id: macro, label: macro }
						}),
						default: macros[0],
					},
				],
				callback: (action) => {
					if (action.options.macro === noMacrosMessage) return
					this.sendCommand('CALL /CTRL/MACROS:run(' + action.options.macro + ')', (result) => {
						this.log('info', 'Run Macro Result: ' + result)
					})
				},
			}
			this.setActionDefinitions(this.actions)
		})
	},

	switchXPT(opt) {
		if (!this.xpPath) {
			this.log('warn', 'Cannot switch: no video crosspoint has been detected yet')
			return
		}
		this.sendCommand(`CALL ${this.xpPath}:switch(${opt.input}:${opt.output})`, (result) => {
			this.log('info', 'XPT Result: ' + result)
		})
	},

	recallPreset(preset) {
		if (this.presetStyle === 'AVC') {
			this.sendCommand(`CALL /PRESETS/AVC:load(${preset})`, (result) => {
				this.log('info', 'Preset Load Result: ' + result)
			})
		} else if (this.presetStyle === 'MEDIA') {
			this.sendCommand(`CALL /MEDIA/PRESET/${preset}:load()`, (result) => {
				this.log('info', 'Preset Load Result: ' + result)
			})
		} else {
			this.log('warn', 'Cannot recall preset: no presets have been detected on this device')
		}
	},

	sendCommand(command, cb) {
		if (this.sendId > 9998) {
			this.sendId = 0
		} else {
			this.sendId++
		}
		let id = this.sendId.toString().padStart(4, '0')

		if (this.socket === undefined) {
			this.log('error', `Cannot send '${command}': socket not connected`)
			return
		}

		try {
			// Registered before sending, because a reply can arrive before send() returns
			this.responseHandlers[id] = cb
			const sent = this.socket.send(id + '#' + command + '\r\n')
			if (sent === false) {
				// No reply will come, so the handler would sit there forever
				delete this.responseHandlers[id]
				this.log('warn', `Could not send '${command}': the connection is not ready`)
				return
			}
			this.trace(`>> ${id}#${command}`)
		} catch (error) {
			delete this.responseHandlers[id]
			this.log('error', `Failed to send '${command}': ${error.message}`)
		}
	},

	parseResponse(line) {
		/**
		 * The subscriptions object holds all definitions for responses to react to
		 * @property pat a string with a regex to check incoming message
		 * @property fun a function to call when pat matches. When the function returnes true, choices and presets will be updated
		 * @property fbk the name of a feedback to check when pat matches
		 */
		let subscriptions = [
			{
				pat: '^(pr|pw|CHG).+\\.DestinationConnection(List|Status)=',
				fun: (res) => {
					let raw = res.replace(/^.+DestinationConnection(List|Status)=/, '').split(';')
					if (raw[raw.length - 1] === '') raw.pop()
					// An output with nothing routed to it is reported as a bare "0" by some
					// firmware revisions. DestinationConnectionStatus may also append status
					// markers (eg. "I3M" when muted), which are not part of the port id.
					const inputs = raw.map((value) => {
						const match = value.match(/^(I\d+|0)[A-Z]*$/)
						return match ? match[1] : null
					})
					if (!inputs.length || inputs.includes(null)) {
						this.log('error', `received malformed connection status: ${res}`)
						return
					}
					this.state.destinationConnectionList = inputs
					this.setVariableValues(Object.fromEntries(inputs.map((value, index) => ['source_O' + (index + 1), value])))
					this.setVariableValues(
						Object.fromEntries(inputs.map((value, index) => ['sourcename_O' + (index + 1), this.inputs[value] || ''])),
					)
				},
				fbk: 'route',
			},
			{
				pat: '^(pr|pw|CHG).+\\.SourcePortStatus=',
				fun: (res) => {
					this.state.sourcePortStatus = parsePortStatusList(res)
				},
				fbk: 'inputLock',
			},
			{
				pat: '^(pr|pw|CHG).+\\.DestinationPortStatus=',
				fun: (res) => {
					this.state.destinationPortStatus = parsePortStatusList(res)
				},
				fbk: 'outputLock',
			},
			{
				pat: '^(pr|pw|CHG).+\\/MEDIA\\/VIDEO\\/(I|O)\\d+\\.Text=',
				fun: (res) => {
					let [port, rawLabel] = res.replace(/^.+\/MEDIA\/VIDEO\//, '').split('.Text=')
					const label = rawLabel?.trim() ?? ''
					if (port.match(/^I\d+$/)) {
						this.inputs[port] = label
						this.setVariableValues({ ['name_' + port]: label })
						this.state.destinationConnectionList
							.map((input, index) => {
								return { in: input, out: 'O' + (index + 1) }
							})
							.filter((item) => item.in === port)
							.forEach((item) => {
								this.setVariableValues({ ['sourcename_' + item.out]: label })
							})
					}
					if (port.match(/^O\d+$/)) {
						this.outputs[port] = label
						this.setVariableValues({ ['name_' + port]: label })
					}
					return true
				},
			},
			{
				pat: '^(pr|pw|CHG).+\\/MEDIA\\/NAMES\\/VIDEO\\.(I|O)\\d+=',
				fun: (res) => {
					const match = res.match(/\/MEDIA\/NAMES\/VIDEO\.([IO]\d+)=\d+;(.+)$/)
					if (!match) return false
					const port = match[1]
					const label = match[2].trim()
					if (port.startsWith('I')) {
						this.inputs[port] = label
						this.setVariableValues({ ['name_' + port]: label })
						this.state.destinationConnectionList
							.map((input, index) => {
								return { in: input, out: 'O' + (index + 1) }
							})
							.filter((item) => item.in === port)
							.forEach((item) => {
								this.setVariableValues({ ['sourcename_' + item.out]: label })
							})
					} else {
						this.outputs[port] = label
						this.setVariableValues({ ['name_' + port]: label })
					}
					return true
				},
			},
			{
				pat: '^(pr|pw|CHG).+\\/PRESETS\\/AVC\\/\\d+\\.Name=',
				fun: (res) => {
					let [preset, label] = res.replace(/^.+\/PRESETS\/AVC\//, '').split('.Name=')
					const index = this.CHOICES_PRESETS.findIndex((choice) => choice.id == preset)
					if (index !== -1) {
						this.CHOICES_PRESETS[index] = { id: preset, label }
						return true
					}
					return false
				},
			},
		]
		let updateGui = false
		subscriptions
			.filter((sub) => {
				const regexp = new RegExp(sub.pat)
				if (line.match(regexp)) {
					return true
				}
				return false
			})
			.forEach((sub) => {
				if (sub.fun && typeof sub.fun === 'function') {
					let update = sub.fun(line)
					if (update === true) updateGui = true
				}
				if (sub.fbk && typeof sub.fbk === 'string') {
					this.checkFeedbacks(sub.fbk)
				}
			})
		if (updateGui) {
			this.initActions()
			this.initFeedbacks()
		}
	},
}
