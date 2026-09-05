/**
 * Builds a dropdown that is valid even before the device has reported its ports.
 * An empty choice list, or a default that is not one of the choices, makes
 * Companion discard the whole action definition.
 */
function dropdown(id, label, choices, emptyLabel) {
	const usable = choices.length > 0 ? choices : [{ id: '', label: emptyLabel }]
	return {
		id,
		label,
		type: 'dropdown',
		choices: usable,
		default: usable[0].id,
	}
}

module.exports = {
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
				dropdown('input', 'Input', this.CHOICES_INPUTS, 'No inputs reported yet'),
				dropdown('output', 'Output', this.CHOICES_OUTPUTS, 'No outputs reported yet'),
			],
			callback: (action) => {
				this.switchXPT(action.options)
			},
		}
		this.actions['preset'] = {
			name: 'Recall Preset',
			options: [dropdown('preset', 'Preset', this.CHOICES_PRESETS, 'No presets stored on the device')],
			callback: (action) => {
				this.recallPreset(action.options.preset.toString())
			},
		}
		this.actions['selectSource'] = {
			name: 'Select source for take',
			options: [dropdown('port', 'Source', this.CHOICES_INPUTS, 'No inputs reported yet')],
			callback: (action) => {
				this.state.selectedSource = action.options.port
				this.checkFeedbacks('sourceSelected', 'route')
			},
		}
		this.actions['selectDestination'] = {
			name: 'Select destination for take',
			options: [dropdown('port', 'Destination', this.CHOICES_OUTPUTS, 'No outputs reported yet')],
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
					this.switchXPT({ input: this.state.selectedSource, output: this.state.selectedDestination })
				}
			},
		}
		this.actions['softreset'] = {
			name: 'Soft Reset Device',
			options: [],
			callback: () => {
				this.sendCommand('CALL /SYS:softReset()', (result) => {
					this.log('info', 'Soft Reset command sent to device.')
				})
			},
		}

		// Lock actions are only offered when the device reported the matching methods.
		// They are built here rather than at detection time so that their port lists
		// are refreshed whenever the port names change.
		const lockDefinitions = [
			{
				id: 'outputLock',
				name: 'Output Lock',
				supported: this.lockSupport?.destination,
				method: 'lockDestination',
				direction: 'destination',
				portLabel: 'Output',
				choices: this.CHOICES_OUTPUTS,
				emptyLabel: 'No outputs reported yet',
				lockLabel: 'Lock Output',
				unlockLabel: 'Unlock Output',
				toggleLabel: 'Toggle Output Lock',
			},
			{
				id: 'inputLock',
				name: 'Input Lock',
				supported: this.lockSupport?.source,
				method: 'lockSource',
				direction: 'source',
				portLabel: 'Input',
				choices: this.CHOICES_INPUTS,
				emptyLabel: 'No inputs reported yet',
				lockLabel: 'Lock Input',
				unlockLabel: 'Unlock Input',
				toggleLabel: 'Toggle Input Lock',
			},
		]

		for (const def of lockDefinitions) {
			if (!def.supported) {
				delete this.actions[def.id]
				continue
			}

			const unlockMethod = def.method.replace(/^lock/, 'unlock')
			this.actions[def.id] = {
				name: def.name,
				options: [
					dropdown('port', def.portLabel, def.choices, def.emptyLabel),
					{
						id: 'cmd',
						type: 'dropdown',
						label: 'Lock',
						choices: [
							{ id: def.method, label: def.lockLabel },
							{ id: unlockMethod, label: def.unlockLabel },
							{ id: 'toggle', label: def.toggleLabel },
						],
						default: unlockMethod,
					},
				],
				callback: (action) => {
					const port = action.options.port
					if (!/^[IO]\d+$/.test(port)) {
						this.log('warn', `Cannot lock: '${port}' is not a valid port`)
						return
					}

					let method = action.options.cmd
					if (method === 'toggle') {
						const locked = this.isPortLocked(def.direction, parseInt(port.slice(1)))
						if (locked === undefined) {
							this.log('warn', `Cannot toggle: the device has not reported a lock state for ${port}`)
							return
						}
						method = locked ? unlockMethod : def.method
					}

					this.sendCommand(`CALL ${this.xpPath}:${method}(${port})`, (result) => {
						this.log('info', `${def.name} Result: ` + result)
					})
				},
			}
		}

		this.trace(
			`registering ${Object.keys(this.actions).length} actions: ${Object.keys(this.actions).join(', ')} ` +
				`(inputs: ${this.CHOICES_INPUTS.length}, outputs: ${this.CHOICES_OUTPUTS.length}, presets: ${this.CHOICES_PRESETS.length})`,
		)
		this.setActionDefinitions(this.actions)
	},
}
