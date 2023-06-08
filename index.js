const { InstanceBase, InstanceStatus, runEntrypoint, TCPHelper, combineRgb } = require('@companion-module/base')

// https://lightware.com/pub/media/lightware/filedownloader/file/Lightware_s_Open_API_Environment_v1.pdf
// https://lightware.com/pub/media/lightware/filedownloader/file/User-Manual/MX2-8x8-HDMI20_series_Users_Manual_v2.4.pdf

class instance extends InstanceBase {
	// TODO: improve enums
	PSTATE_READY = 0
	PSTATE_MULTILINE = 1
	PSTATE_SINGLELINE = 2
	DTYPE_UNKNOWN = 0
	DTYPE_GENERAL = 'GENERAL'
	DTYPE_MX2 = 'MX2'

	actions = {}
	variables = {}
	presets = {}
	state = { destinationConnectionList: [], selectedSource: '', selectedDestination: '' }

	deviceType = this.DTYPE_UNKNOWN
	inputs = {}
	outputs = {}
	CHOICES_INPUTS = []
	CHOICES_OUTPUTS = []
	CHOICES_PRESETS = []

	constructor(internal) {
		super(internal)
		this.instanceOptions.disableVariableValidation = true
	}

	getConfigFields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'This module is for controlling Lightware equipment that supports LW3 protocol. So far only HDMI20_OPTC and MX2-8x8-HDMI20 have been tested. Please contact us if your LW3 compatible equipment is not supported',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Device IP',
				width: 12,
				regex: this.REGEX_IP,
			},
		]
	}

	async destroy() {
		if (this.socket !== undefined) {
			this.socket.destroy()
		}

		this.debug('destroy', this.id)
	}

	async init(config) {
		this.config = config
		this.updateStatus(InstanceStatus.Connecting)
		this.initTCP()
		this.initVariables()
		this.initFeedbacks()
		this.initPresets()
	}

	initActions() {
		this.CHOICES_INPUTS = Object.keys(this.inputs).map((key) => {
			return { id: key, label: this.inputs[key] }
		})
		this.CHOICES_OUTPUTS = Object.keys(this.outputs).map((key) => {
			return { id: key, label: this.outputs[key] }
		})

		this.actions['xpt'] = {
			name: 'XP:Switch - Select video input for output',
			options: [
				{
					label: 'Input',
					type: 'dropdown',
					id: 'input',
					choices: this.CHOICES_INPUTS,
					default: this.CHOICES_INPUTS[0]?.id || '',
				},
				{
					label: 'Output',
					type: 'dropdown',
					id: 'output',
					choices: this.CHOICES_OUTPUTS,
					default: this.CHOICES_OUTPUTS[0]?.id || '',
				},
			],
			callback: (action) => {
				let opt = action.options
				this[this.deviceType + '_XPT'](opt)
			},
		}
		this.actions['preset'] = {
			name: 'Recall Preset',
			options: [
				{
					label: 'Preset',
					type: 'dropdown',
					id: 'preset',
					choices: this.CHOICES_PRESETS,
					default: this.CHOICES_PRESETS[0]?.id || '',
				},
			],
			callback: (action) => {
				let opt = action.options
				if (this.deviceType === this.DTYPE_GENERAL) {
					this.sendCommand('CALL /PRESETS/AVC:load(' + opt.preset.toString() + ')', (result) => {
						this.log('info', 'Preset Load Result: ' + result)
					})
				} else if (this.deviceType === this.DTYPE_MX2) {
					this.sendCommand('CALL /MEDIA/PRESET/' + opt.preset.toString() + ':load()', (result) => {
						this.log('info', 'Preset Load Result: ' + result)
					})
				}
			},
		}
		this.actions['selectSource'] = {
			name: 'Select source for take',
			options: [
				{
					label: 'Source',
					type: 'dropdown',
					id: 'port',
					choices: this.CHOICES_INPUTS,
					default: this.CHOICES_INPUTS[0]?.id || '',
				},
			],
			callback: (action) => {
				this.state.selectedSource = action.options.port
				this.checkFeedbacks('sourceSelected', 'route')
			},
		}
		this.actions['selectDestination'] = {
			name: 'Select destination for take',
			options: [
				{
					label: 'Destination',
					type: 'dropdown',
					id: 'port',
					choices: this.CHOICES_OUTPUTS,
					default: this.CHOICES_OUTPUTS[0]?.id || '',
				},
			],
			callback: (action) => {
				this.state.selectedDestination = action.options.port
				this.checkFeedbacks('destinationSelected', 'route')
			},
		}
		this.actions['takeSalvo'] = {
			name: 'Route selected ports',
			options: [],
			callback: () => {
				if (this.state.selectedSource.match(/^I\d+$/) && this.state.selectedDestination.match(/^O\d+$/)) {
					this[this.deviceType + '_XPT']({ input: this.state.selectedSource, output: this.state.selectedDestination })
				}
			},
		}

		this.setActionDefinitions(this.actions)
	}

	initFeedbacks() {
		let instance = this
		const feedbacks = {}
		feedbacks['route'] = {
			type: 'boolean',
			name: 'Route',
			description: 'Shows if an input is routed to an output',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0),
			},
			options: [
				{
					type: 'number',
					label: 'Input',
					id: 'input',
					tooltip: '0 = selected',
					default: 1,
					min: 0,
					max: 512,
				},
				{
					type: 'number',
					label: 'Output',
					id: 'output',
					tooltip: '0 = selected',
					default: 1,
					min: 0,
					max: 512,
				},
			],
			callback: (feedback) => {
				try {
					let outputnum =
						feedback.options.output > 0
							? feedback.options.output
							: instance.state.selectedDestination.replace(/\D/g, '')
					let input = feedback.options.input > 0 ? 'I' + feedback.options.input : instance.state.selectedSource
					if (instance.state.destinationConnectionList[outputnum - 1] === input) {
						return true
					} else {
						return false
					}
				} catch (error) {
					this.log('error', 'trying to read feedback status for a invalid input or output')
					return false
				}
			},
		}
		feedbacks['sourceSelected'] = {
			type: 'boolean',
			name: 'source selected',
			description: 'Shows if an input is selected for routing',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(0, 255, 0),
			},
			options: [
				{
					type: 'number',
					label: 'Input',
					id: 'port',
					default: 1,
					min: 1,
					max: 512,
				},
			],
			callback: (feedback) => {
				try {
					if (instance.state.selectedSource === 'I' + feedback.options.port) {
						return true
					} else {
						return false
					}
				} catch (error) {
					this.log('error', 'trying to read feedback status for a invalid input or output')
					return false
				}
			},
		}
		feedbacks['destinationSelected'] = {
			type: 'boolean',
			name: 'destination selected',
			description: 'Shows if an output is selected for routing',
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(0, 255, 0),
			},
			options: [
				{
					type: 'number',
					label: 'Output',
					id: 'port',
					default: 1,
					min: 1,
					max: 512,
				},
			],
			callback: (feedback) => {
				try {
					if (instance.state.selectedDestination === 'O' + feedback.options.port) {
						return true
					} else {
						return false
					}
				} catch (error) {
					this.log('error', 'trying to read feedback status for a invalid input or output')
					return false
				}
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	initVariables() {
		this.setVariableDefinitions(
			Object.keys(this.variables).map((key) => {
				return { variableId: key, name: this.variables[key] }
			})
		)
	}

	createSelectPreset(port) {
		let pdat = {
			port,
			num: parseInt(port.replace(/\D/g, '')),
			shorttype: port.charAt(0),
		}
		pdat.type = { I: 'Input', O: 'Output' }[pdat.shorttype] || ''
		pdat.action = { I: 'selectSource', O: 'selectDestination' }[pdat.shorttype] || ''
		pdat.option = { I: 'source', O: 'destination' }[pdat.shorttype] || ''

		this.presets['selection' + port] = {
			name: 'Select ' + pdat.type + ' ' + pdat.num,
			type: 'button',
			category: 'Select ' + pdat.type,
			style: {
				text: `${pdat.type}\\n$(${this.label}:name_${pdat.port})`,
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(30, 30, 30),
			},
			steps: [
				{
					down: [
						{
							actionId: pdat.action,
							options: {
								port: pdat.port,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: pdat.option + 'Selected',
					options: {
						port: pdat.num,
					},
					style: {
						color: combineRgb(0, 255, 0),
						bgcolor: combineRgb(0, 70, 0),
					},
				},
				{
					feedbackId: 'route',
					options: {
						input: pdat.shorttype === 'I' ? pdat.num : 0,
						output: pdat.shorttype === 'O' ? pdat.num : 0,
					},
					style: {
						bgcolor: combineRgb(150, 0, 0),
					},
				},
			],
		}

		if (pdat.shorttype === 'I')
			this.presets['selectAndTake' + port] = {
				name: 'Select Input ' + pdat.num + ' and Take',
				type: 'button',
				category: 'Select Input and Take',
				style: {
					text: `Input\\n$(${this.label}:name_${pdat.port})`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(60, 0, 0),
				},
				steps: [
					{
						down: [
							{
								actionId: pdat.action,
								options: {
									port: pdat.port,
								},
							},
							{
								actionId: 'takeSalvo',
							},
						],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: pdat.option + 'Selected',
						options: {
							port: pdat.num,
						},
						style: {
							color: combineRgb(0, 255, 0),
							bgcolor: combineRgb(0, 70, 0),
						},
					},
					{
						feedbackId: 'route',
						options: {
							input: pdat.shorttype === 'I' ? pdat.num : 0,
							output: pdat.shorttype === 'O' ? pdat.num : 0,
						},
						style: {
							bgcolor: combineRgb(150, 0, 0),
						},
					},
				],
			}
	}

	initPresets() {
		this.presets['take'] = {
			type: 'button',
			name: 'Take Selected',
			type: 'button',
			category: 'Misc',
			style: {
				text: 'Take selected',
				size: 'auto',
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(180, 30, 30),
			},
			steps: [
				{
					down: [
						{
							actionId: 'takeSalvo',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		this.setPresetDefinitions(this.presets)
	}

	initDevice() {
		this.sendCommand('GET /.ProductName', (result) => {
			result = result.replace(/^.+ProductName=/, '')

			this.log('info', 'Connected to an ' + result)

			if (
				result.match(/OPTC-[TR]X|MMX\d+x\d+|UMX-TPS-[TR]X100/) ||
				result.match(/(^MEX-)|HDMI-TPS-[TR]X200|HDMI-3D-OPT|SW4-OPT|MODEX/)
			) {
				this.deviceType = this.DTYPE_GENERAL
				this.initGENERAL()
			} else if (result.match(/^MX2/)) {
				this.deviceType = this.DTYPE_MX2
				this.initMX2()
			} else {
				this.log('warning', 'Unknown LW3 device, use with caution')
				this.deviceType = this.DTYPE_GENERAL
				this.initMX2()
			}
		})
		// The following actions are added only if the device has the corredponding paths
		this.sendCommand('GET /MEDIA/VIDEO/XP.*', (result) => {
			let list = result.split(/\r\n/)
			if (list.find((item) => item.match(/XP:lockDestination/))) {
				let outputnum = parseInt(
					list.find((item) => item.match(/XP\.DestinationPortCount=\d+/)).match(/XP\.DestinationPortCount=(\d+)$/)[1]
				)
				this.actions['outputLock'] = {
					name: 'Output Lock',
					options: [
						{
							id: 'output',
							type: 'number',
							label: 'Output',
							min: 1,
							max: outputnum,
							default: 1,
						},
						{
							id: 'cmd',
							type: 'dropdown',
							label: 'Lock',
							choices: [
								{ id: 'lockDestination', label: 'Lock Output' },
								{ id: 'unlockDestination', label: 'Unlock Output' },
							],
							default: 'unlockDestination',
						},
					],
					callback: (action) => {
						this.sendCommand(`CALL /MEDIA/VIDEO/XP:${action.options.cmd}(O${action.options.output})`, (result) => {
							this.log('info', 'Output Lock Result: ' + result)
						})
					},
				}
			}
		})
		this.sendCommand('GET /MEDIA/USB/USBSWITCH.*', (result) => {
			let list = result.split(/\r\n/)
			if (list.find((item) => item.match(/Enable\d+=/))) {
				let hosts = list.filter((item) => item.match(/Enable\d+=/)).map((item) => item.match(/Enable(\d+)=/)[1])
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
			}
		})
		this.sendCommand('GET /CTRL/MACROS.*', (result) => {
			const noMacrosMessage = 'No macros available'
			let list = result.split(/\r\n/)
			if (list.find((item) => item.match(/MACROS.\d+=/))) {
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
			}
		})
	}

	initGENERAL() {
		this.sendCommand('OPEN /MEDIA/VIDEO/*.Text', (result) => {})
		this.sendCommand('GET /MEDIA/VIDEO/*.Text', (result) => {
			let list = result.split(/\r\n/)

			this.CHOICES_INPUTS.length = 0
			this.CHOICES_OUTPUTS.length = 0

			for (let i in list) {
				let match = list[i].match(/\/MEDIA\/VIDEO\/(.+?)\.Text=(.+)$/)
				if (match) {
					let port = match[1]
					let name = match[2]

					if (port.match(/I\d+/)) {
						this.inputs[port] = name
						this.CHOICES_INPUTS.push({ label: name, id: port })
						this.variables['name_' + port] = 'Name of input ' + port.slice(1)
						this.setVariableValues({ ['name_' + port]: name })
					}
					if (port.match(/O\d+/)) {
						this.outputs[port] = name
						this.CHOICES_OUTPUTS.push({ label: name, id: port })
						this.variables['name_' + port] = 'Name of output ' + port.slice(1)
						this.setVariableValues({ ['name_' + port]: name })
						this.variables['source_' + port] = 'Source at output ' + port.slice(1)
						this.variables['sourcename_' + port] = 'Name of source at output ' + port.slice(1)
					}
					this.createSelectPreset(port)
				}
			}
			this.initActions()
			this.initVariables()
			this.setPresetDefinitions(this.presets)
		})
		this.sendCommand('GET /PRESETS/AVC/*.Name', (result) => {
			let list = result.split(/\r\n/)
			this.log('debug', list)

			this.CHOICES_PRESETS = [
				...list
					.filter((item) => {
						return item.match(/\/PRESETS\/AVC\/(.+?)\.Name=(.+)$/) !== undefined
					})
					.map((item) => {
						let [_all, preset, name] = item.match(/\/PRESETS\/AVC\/(.+?)\.Name=(.+)$/)
						return { id: preset, label: name }
					}),
			]
			this.initActions()
		})
		this.sendCommand('OPEN /MEDIA/VIDEO/XP', (result) => {})
		this.sendCommand('GET /MEDIA/VIDEO/XP.DestinationConnectionList', (result) => {
			result.split(/\r\n/).forEach((line) => this.parseResponse(line))
			this.checkFeedbacks('route')
		})
	}

	initMX2() {
		this.sendCommand('GET /MEDIA/NAMES/VIDEO.*', (result) => {
			let list = result.split(/\r\n/)
			this.log('debug', list)

			this.CHOICES_INPUTS.length = 0
			this.CHOICES_OUTPUTS.length = 0

			for (let i in list) {
				let match = list[i].match(/\/MEDIA\/NAMES\/VIDEO\.(.+?)=\d+;(.+)$/)
				if (match) {
					let port = match[1]
					let name = match[2]

					if (port.match(/I\d+/)) {
						this.inputs[port] = name
						this.CHOICES_INPUTS.push({ label: name, id: port })
						this.variables['name_' + port] = 'Name of input ' + port.slice(1)
						this.setVariableValues({ ['name_' + port]: name })
					}
					if (port.match(/O\d+/)) {
						this.outputs[port] = name
						this.CHOICES_OUTPUTS.push({ label: name, id: port })
						this.variables['name_' + port] = 'Name of output ' + port.slice(1)
						this.setVariableValues({ ['name_' + port]: name })
						this.variables['source_' + port] = 'Source at output ' + port.slice(1)
						this.variables['sourcename_' + port] = 'Name of source at output ' + port.slice(1)
					}
					this.createSelectPreset(port)
				}
			}
			this.initActions()
			this.initVariables()
			this.setPresetDefinitions(this.presets)
		})
		this.CHOICES_PRESETS = []

		this.sendCommand('GET /PRESETS/AVC/*.Name', (result) => {
			if (typeof result !== 'string') {
				this.log('error', `Got invalid response to 'GET /PRESETS/AVC/*.Name'. Response was:${result}`)
				return
			}
			if (!result.startsWith('nE')) {
				let list = result
					.split(/\r\n/)
					.filter((item) => {
						return Array.isArray(item.match(/\/PRESETS\/AVC\/(.+?)\.Name=(.+)$/))
					})
					.map((item) => {
						let [_all, preset, name] = item.match(/\/PRESETS\/AVC\/(.+?)\.Name=(.+)$/)
						return { id: preset, label: name }
					})
				if (list.length) {
					this.CHOICES_PRESETS.push(...list)
					this.initActions()
					return
				} else {
					this.log(
						'debug',
						`Response to 'GET /PRESETS/AVC/*.Name' didn't have any presets. Response was:${result}\nNow trying with /MEDIA/PRESET`
					)
				}
			}

			this.sendCommand('GET /MEDIA/PRESET', (result) => {
				if (typeof result !== 'string' || result.startsWith('nE')) {
					this.log('error', `Got invalid response to 'GET /MEDIA/PRESET'. Response was:${result}`)
					return
				}
				let list = result
					.split(/\r\n/)
					.filter((item) => {
						return Array.isArray(item.match(/\/MEDIA\/PRESET\/([A-Za-z0-9\-_]{1,16})/))
					})
					.map((item) => {
						let [_all, preset] = item.match(/MEDIA\/PRESET\/([A-Za-z0-9\-_]{1,16})/)
						return { id: preset, label: preset }
					})
				if (list.length) {
					this.CHOICES_PRESETS.push(...list)
					this.log(
						'info',
						`'GET /MEDIA/PRESET' found ${list.length} presets with the names: ${list.map((i) => i.label).join(', ')}`
					)
					this.initActions()
				} else {
					this.log('info', `Response to 'GET /MEDIA/PRESET' didn't have any presets. Response was:${result}`)
				}
			})
		})
		this.sendCommand('OPEN /MEDIA/XP/VIDEO', (result) => {})
		this.sendCommand('GET /MEDIA/XP/VIDEO.DestinationConnectionList', (result) => {
			result.split(/\r\n/).forEach((line) => this.parseResponse(line))
			this.checkFeedbacks('route')
		})
	}

	initTCP() {
		let instance = this
		let receivebuffer = ''
		this.pstate = this.PSTATE_READY
		this.pid = ''
		this.multiline = ''
		this.multilineError = ''
		this.responseHandlers = {}
		this.sendId = 0

		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}
		this.log('info', this.config.host)
		if (this.config.host) {
			this.socket = new TCPHelper(this.config.host, 6107)

			this.socket.on('status_change', (status, message) => {
				instance.updateStatus(status, message)
			})

			this.socket.on('connect', () => {
				instance.initDevice()
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
				if (instance.pstate === instance.PSTATE_READY && line.startsWith('{')) {
					instance.pstate = instance.PSTATE_MULTILINE
					instance.multiline = ''
					instance.multilineError = ''
					instance.pid = line.slice(1)
				} else if (instance.pstate === instance.PSTATE_MULTILINE) {
					if (line === '}') {
						if (instance.responseHandlers[this.pid] !== undefined) {
							if (instance.multilineError.trim() != '') {
								instance.log('error', 'Error from device: ' + instance.multilineError)
							}

							instance.responseHandlers[instance.pid](instance.multiline.trim())
							delete instance.responseHandlers[instance.pid]
						}

						instance.pstate = instance.PSTATE_READY
					} else {
						if (line.slice(1, 1) == 'E') {
							instance.multilineError += line + '\r\n'
						} else {
							instance.multiline += line + '\r\n'
						}
					}
				} else {
					this.parseResponse(line)
				}
			})
		}
	}

	GENERAL_XPT(opt) {
		this.sendCommand('CALL /MEDIA/VIDEO/XP:switch(' + opt.input + ':' + opt.output + ')', (result) => {
			this.log('info', 'XPT Result: ' + result)
		})
	}

	MX2_XPT(opt) {
		this.sendCommand('CALL /MEDIA/XP/VIDEO:switch(' + opt.input + ':' + opt.output + ')', (result) => {
			this.log('info', 'XPT Result: ' + result)
		})
	}

	sendCommand(command, cb) {
		if (this.sendId > 9998) {
			this.sendId = 0
		} else {
			this.sendId++
		}
		let id = this.sendId.toString().padStart(4, '0')

		if (this.socket !== undefined) {
			this.socket.send(id + '#' + command + '\r\n')
			this.responseHandlers[id] = cb
		} else {
			this.log('debug', 'Socket not connected :(')
		}
	}

	parseResponse(line) {
		/**
		 * The subscriptions object holds all definitions for responses to react to
		 * @property pat a string with a regex to check incoming message
		 * @property fun a function to call when pat matches. When the function returnes true, choices and presets will be updated
		 * @property fbk the name of a feedback to check when pat matches
		 */
		let subscriptions = [
			{
				pat: '^(pr|CHG).+\\.DestinationConnection(List|Status)=',
				fun: (res) => {
					let inputs = res.replace(/^.+DestinationConnection(List|Status)=/, '').split(';')
					if (!Array.isArray(inputs)) {
						this.log('error', `received very malformed connection status: ${res}`)
						return
					}
					if (inputs[0].match(/^I\d+$/)) {
						if (inputs[inputs.length - 1] === '') inputs.pop()
						this.state.destinationConnectionList = inputs
						this.setVariableValues(Object.fromEntries(inputs.map((value, index) => ['source_O' + (index + 1), value])))
						this.setVariableValues(
							Object.fromEntries(inputs.map((value, index) => ['sourcename_O' + (index + 1), this.inputs[value]]))
						)
					} else {
						this.log('error', `received malformed connection status: ${res}`)
						return
					}
				},
				fbk: 'route',
			},
			{
				pat: '^(pr|CHG).+\\/MEDIA\\/VIDEO\\/(I|O)\\d+\\.Text=',
				fun: (res) => {
					let [port, label] = res.replace(/^.+\/MEDIA\/VIDEO\//, '').split('.Text=')
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
				pat: '^(pr|CHG).+\\/PRESETS\\/AVC\\/\\d+\\.Name=',
				fun: (res) => {
					let [preset, label] = res.replace(/^.+\/PRESETS\/AVC\//, '').split('.Name=')
					if (preset > 0) {
						const idx = this.CHOICES_PRESETS.find((choice) => choice.id == preset.toString())
						if (idx) {
							this.CHOICES_PRESETS[idx] = { id: preset, label }
							return true
						}
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
	}

	updateConfig(config) {
		let resetConnection = false

		if (this.config.host != config.host) {
			resetConnection = true
		}

		this.config = config

		if (resetConnection === true || this.socket === undefined) {
			this.initTCP()
		}
	}
}

runEntrypoint(instance, [])
