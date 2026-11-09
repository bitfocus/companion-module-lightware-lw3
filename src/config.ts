import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	host: string
	/**
	 * Not a setting: the router reports its LW3 port as read-only, always 6107. This is only for pointing
	 * the module's tests at a fake router.
	 */
	port?: number
	autoRoute?: AutoRouteMode
}

export type AutoRouteMode = 'off' | 'stage' | 'cut'

/** The order the mode button steps through: the live mode comes last, after the safer one */
export const AUTO_ROUTE_ORDER: AutoRouteMode[] = ['off', 'stage', 'cut']

export const AUTO_ROUTE_LABELS: Record<AutoRouteMode, string> = { off: 'OFF', stage: 'STAGE', cut: 'CUT' }

export function GetConfigFields(label: string, router: string): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'router',
			width: 12,
			label: 'Router',
			value: router,
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Router IP',
			width: 6,
			regex: Regex.IPV4,
		},
		{
			type: 'dropdown',
			id: 'autoRoute',
			label: 'When an input and an output are both selected',
			width: 12,
			default: 'off',
			choices: [
				{ id: 'off', label: 'Wait for the take button' },
				{ id: 'cut', label: 'Take straight away' },
				{ id: 'stage', label: 'Stage straight away (build a salvo, then take it)' },
			],
		},
		{
			type: 'static-text',
			id: 'portsInfo',
			width: 12,
			label: 'Port names, EDID and HDCP',
			value: `To edit many ports at once, [open the ports page](/instance/${label}/).`,
		},
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value:
				'Connects to a Lightware matrix router over LW3. Only the MX2-8x8-HDMI20-L, MX2-8X8-HDMI20-AUDIO, MX2-16x16-HDMI20-R and MX2-24x24-HDMI20-R have been tested so far. See the help for what that means for other models.',
		},
	]
}
