const { combineRgb } = require('@companion-module/base')

module.exports = {
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

		for (const lock of [
			{
				id: 'inputLock',
				name: 'input locked',
				label: 'Input',
				direction: 'source',
				choices: this.CHOICES_INPUTS,
				emptyLabel: 'No inputs reported yet',
			},
			{
				id: 'outputLock',
				name: 'output locked',
				label: 'Output',
				direction: 'destination',
				choices: this.CHOICES_OUTPUTS,
				emptyLabel: 'No outputs reported yet',
			},
		]) {
			const usable = lock.choices.length > 0 ? lock.choices : [{ id: '', label: lock.emptyLabel }]
			feedbacks[lock.id] = {
				type: 'boolean',
				name: lock.name,
				description: `Shows if an ${lock.label.toLowerCase()} is locked on the device`,
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(200, 100, 0),
				},
				options: [
					{
						type: 'dropdown',
						label: lock.label,
						id: 'port',
						choices: usable,
						default: usable[0].id,
					},
				],
				callback: (feedback) => {
					const port = feedback.options.port
					if (!/^[IO]\d+$/.test(port)) return false
					return instance.isPortLocked(lock.direction, parseInt(port.slice(1))) === true
				},
			}
		}

		this.setFeedbackDefinitions(feedbacks)
	},
}
