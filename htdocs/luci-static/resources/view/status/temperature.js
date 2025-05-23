'use strict';
'require dom';
'require poll';
'require request';
'require rpc';
'require view';
'require ui';

document.head.append(E('style', {'type': 'text/css'},
`
:root {
	--app-temp-status-temp: #147aff;
	--app-temp-status-hot: orange;
	--app-temp-status-crit: red;
}
.svg_background {
	width: 100%;
	height: 300px;
	border: 1px solid #000;
	background: #fff';
}
[data-darkmode="true"] .svg_background {
	background-color: var(--background-color-high) !important;
}
.graph_legend {
	border-bottom: 2px solid;
}
.temp {
	border-color: var(--app-temp-status-temp);
}
.hot {
	border-color: var(--app-temp-status-hot);
}
.crit {
	border-color: var(--app-temp-status-crit);
}
svg line.grid {
	stroke: black;
	stroke-width: 0.1;
}
[data-darkmode="true"] svg line.grid {
	stroke: #fff !important;
}
svg text {
	fill: #eee;
	font-size: 9pt;
	font-family: sans-serif;
	text-shadow: 1px 1px 1px #000;
}
svg #temp_line {
	fill: var(--app-temp-status-temp);
	fill-opacity: 0.4;
	stroke: var(--app-temp-status-temp);
	stroke-width: 1;
}
svg #hot_line {
	stroke: var(--app-temp-status-hot);
	stroke-width: 1;
}
svg #crit_line {
	stroke: var(--app-temp-status-crit);
	stroke-width: 1;
}
`));

Math.log2 = Math.log2 || (x => Math.log(x) * Math.LOG2E);

return view.extend({
	tempHot       : 90,

	tempCritical  : 100,

	pollInterval  : 3,

	tempBufferSize: 4,

	tempSources   : {},

	graphPolls    : [],

	callTempStatus: rpc.declare({
		object: 'luci.temp-status',
		method: 'getTempStatus',
		expect: { '': {} }
	}),

	formatTemp(mc) {
		return Number((mc / 1e3).toFixed(1));
	},

	sortFunc(a, b) {
		return (a.number > b.number) ? 1 : (a.number < b.number) ? -1 : 0;
	},

	getTempData(temp_data) {
		return this.callTempStatus().then(temp_data => {
			if(temp_data) {
				for(let e of Object.values(temp_data)) {
					e.sort(this.sortFunc);

					for(let i of Object.values(e)) {
						let sensor = i.title || i.item;

						if(i.sources === undefined) {
							continue;
						};

						i.sources.sort(this.sortFunc);

						for(let j of i.sources) {
							let temp = j.temp;
							let path = j.path;
							let name = (j.label !== undefined) ? sensor + " / " + j.label :
								(j.item !== undefined) ? sensor + " / " + j.item.replace(/_input$/, "") : sensor

							if(temp !== undefined) {
								temp = this.formatTemp(temp);
							};

							let temp_hot      = this.tempHot;
							let temp_critical = this.tempCritical;
							let tpoints       = j.tpoints;

							if(tpoints) {
								for(let i of Object.values(tpoints)) {
									let t = this.formatTemp(i.temp);
									if(i.type === 'critical' || i.type === 'emergency') {
										temp_critical = t;
									}
									else if(i.type === 'hot' || i.type === 'max') {
										temp_hot = t;
									};
								};
							};

							if(!(path in this.tempSources)) {
								this.tempSources[path] = {
									name,
									path,
									temp: [],
									temp_hot,
									temp_critical,
									tpoints,
								};
							};

							let temp_array = this.tempSources[path].temp;
							temp_array.push([ new Date().getTime(), temp || 0 ]);
							if(temp_array.length > this.tempBufferSize) {
								temp_array.shift();
							};
						};
					};
				};
			};
			return this.tempSources;
		});
	},

	loadSVG(src) {
		return request.get(src).then(response => {
			if(!response.ok) {
				throw new Error(response.statusText);
			};

			return E('div', {
				'class': 'svg_background',
			}, E(response.text()));
		});
	},

	updateGraph(tpath, svg, lines, cb) {
		let G             = svg.firstElementChild;
		let view          = document.querySelector('#view');
		let width         = view.offsetWidth - 2;
		let height        = 300 - 2;
		let step          = 5;
		let data_wanted   = Math.floor(width / step);
		let data_values   = [];
		let line_elements = [];

		for(let i = 0; i < lines.length; i++) {
			if(lines[i] != null) {
				data_values.push([]);
			};
		};

		let info = {
			line_current: [],
			line_average: [],
			line_peak   : [],
		};

		/* prefill datasets */
		for(let i = 0; i < data_values.length; i++) {
			for(let j = 0; j < data_wanted; j++) {
				data_values[i][j] = 0;
			};
		};

		/* plot horizontal time interval lines */
		for(let i = width % (step * 60); i < width; i += step * 60) {
			let line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
				line.setAttribute('x1', i);
				line.setAttribute('y1', 0);
				line.setAttribute('x2', i);
				line.setAttribute('y2', '100%');
				line.setAttribute('class', 'grid');

			let text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				text.setAttribute('x', i + 5);
				text.setAttribute('y', 15);
				text.append(document.createTextNode(Math.round((width - i) / step / 60) + 'm'));

			G.append(line);
			G.append(text);
		};

		info.interval  = this.pollInterval;
		info.timeframe = data_wanted / 60;

		this.graphPolls.push({
			tpath,
			svg,
			lines,
			cb,
			info,
			width,
			height,
			step,
			values   : data_values,
			timestamp: 0,
			fill     : 1,
		});
	},

	pollData() {
		poll.add(L.bind(function() {
			return this.getTempData().then(L.bind(function(datasets) {

				for(let gi = 0; gi < this.graphPolls.length; gi++) {
					let ctx = this.graphPolls[gi];

					if(!datasets[ctx.tpath]) {
						continue;
					};

					let data = datasets[ctx.tpath].temp;

					if(!data) {
						continue;
					};

					let values         = ctx.values;
					let lines          = ctx.lines;
					let info           = ctx.info;
					let temp_hot       = datasets[ctx.tpath].temp_hot;
					let temp_crit      = datasets[ctx.tpath].temp_critical;
					let data_scale     = 0;
					let data_wanted    = Math.floor(ctx.width / ctx.step);
					let last_timestamp = NaN;

					for(let i = 0, di = 0; di < lines.length; di++) {
						if(lines[di] == null) {
							continue;
						};

						let multiply = (lines[di].multiply != null) ? lines[di].multiply : 1;
						let offset   = (lines[di].offset != null) ? lines[di].offset : 0;

						for(let j = ctx.timestamp ? 0 : 1; j < data.length; j++) {

							/* skip overlapping and empty entries */
							if(data[j][0] <= ctx.timestamp) {
								continue;
							};

							if(i == 0) {
								ctx.fill++;
								last_timestamp = data[j][0];
							};

							info.line_current[i] = data[j][di + 1] * multiply;
							info.line_current[i] -= Math.min(info.line_current[i], offset);
							values[i].push(info.line_current[i]);
						};

						i++;
					}

					/* cut off outdated entries */
					ctx.fill = Math.min(ctx.fill, data_wanted);

					for(let i = 0; i < values.length; i++) {
						let len = values[i].length;
						values[i] = values[i].slice(len - data_wanted, len);

						/* find peaks, averages */
						info.line_peak[i]    = NaN;
						info.line_average[i] = 0;

						for(let j = 0; j < values[i].length; j++) {
							info.line_peak[i]    = isNaN(info.line_peak[i]) ? values[i][j] : Math.max(info.line_peak[i], values[i][j]);
							info.line_average[i] += values[i][j];
						};

						info.line_average[i] = info.line_average[i] / ctx.fill;
					};

					info.peak = Math.max.apply(Math, info.line_peak);

					/* remember current timestamp, calculate horizontal scale */
					if(!isNaN(last_timestamp)) {
						ctx.timestamp = last_timestamp;
					};

					let size = Math.floor(Math.log2(info.peak));
					let div  = Math.pow(2, size - (size % 10));
					let mult = info.peak / div;
					    mult = (mult < 5) ? 2 : ((mult < 50) ? 10 : ((mult < 500) ? 100 : 1000));

					info.peak  = info.peak + (mult * div) - (info.peak % (mult * div));
					data_scale = ctx.height / info.peak;

					/* plot data */
					for(let i = 0, di = 0; di < lines.length; di++) {
						if(lines[di] == null) {
							continue;
						};

						let el = ctx.svg.firstElementChild.getElementById(lines[di].line);
						let pt = '0,' + ctx.height;
						let y  = 0;

						if(!el) {
							continue;
						};

						for(let j = 0; j < values[i].length; j++) {
							let x = j * ctx.step;

							y = ctx.height - Math.floor(values[i][j] * data_scale);
							//y -= Math.floor(y % (1 / data_scale));

							y = isNaN(y) ? ctx.height : y;
							pt += ` ${x},${y}`;
						};

						pt += ` ${ctx.width},${y} ${ctx.width},${ctx.height}`;
						el.setAttribute('points', pt);

						i++;
					};

					/* hot line */
					let hot_line = ctx.svg.firstElementChild.getElementById('hot_line');
					    hot_line.setAttribute('y1', ctx.height - Math.floor(temp_hot * data_scale));
					    hot_line.setAttribute('y2', ctx.height - Math.floor(temp_hot * data_scale));

					/* critical line */
					let crit_line = ctx.svg.firstElementChild.getElementById('crit_line');
					    crit_line.setAttribute('y1', ctx.height - Math.floor(temp_crit * data_scale));
					    crit_line.setAttribute('y2', ctx.height - Math.floor(temp_crit * data_scale));

					info.label_25 = 0.25 * info.peak;
					info.label_50 = 0.50 * info.peak;
					info.label_75 = 0.75 * info.peak;

					if(typeof(ctx.cb) == 'function') {
						ctx.cb(ctx.svg, info);
					};
				};
			}, this));
		}, this), this.pollInterval);
	},

	load() {
		return Promise.all([
			this.loadSVG(L.resource('svg/temperature.svg')),
			this.getTempData(),
		]);
	},

	render(data) {
		let svg      = data[0];
		let tsources = data[1];
		let map      = E('div', { 'class': 'cbi-map', 'id': 'map' });

		if(!tsources || Object.keys(tsources).length == 0) {
			map.append(E('div', { 'class': 'cbi-section' },
				E('div', { 'class': 'cbi-section-node' },
					E('div', { 'class': 'cbi-value' },
						E('em', {}, _('No temperature sensors available'))
					)
				)
			));
		} else {
			let tabs = E('div');
			map.append(tabs);

			for(let i of Object.values(tsources)) {
				let tsource_name    = i.name;
				let tsource_path    = i.path;
				let tsource_hot     = i.temp_hot;
				let tsource_crit    = i.temp_critical;
				let tsource_tpoints = i.tpoints;

				if(!tsource_name || !tsource_path) {
					continue;
				};

				let csvg            = svg.cloneNode(true);
				let tpoints_section = null;

				if(tsource_tpoints) {
					tpoints_section   = E('div', { 'class': 'cbi-section-node' })
					let tpoints_table = E('table', { 'class': 'table' });
					tpoints_section.append(tpoints_table);

					for(let i of Object.values(tsource_tpoints)) {
						tpoints_table.append(
							E('tr', { 'class': 'tr' }, [
								E('td', { 'class': 'td left' }, i.type),
								E('td', { 'class': 'td left' }, this.formatTemp(i.temp) + ' °C' ),
							])
						);
					};
				};

				tabs.append(E('div', { 'class': 'cbi-section', 'data-tab': tsource_path, 'data-tab-title': tsource_name }, [
					csvg,
					E('div', { 'class': 'right' }, E('small', { 'id': 'scale' }, '-')),
					E('br'),
					E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
						E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td right top' }, E('strong', { 'class': 'graph_legend temp' }, _('Temperature') + ':')),
							E('td', { 'class': 'td', 'id': 'temp_cur' }, '0'),
							/*
							E('td', { 'class': 'td right top' }, E('strong', {}, _('Average:'))),
							E('td', { 'class': 'td', 'id': 'temp_avg' }, '0'),
							*/
							E('td', { 'class': 'td right top' }, E('strong', {}, _('Peak:'))),
							E('td', { 'class': 'td', 'id': 'temp_peak' }, '0'),

							E('td', { 'class': 'td right top' }, E('strong', { 'class': 'graph_legend hot' }, _('Hot:'))),
							E('td', { 'class': 'td', 'id': 'temp_hot' }, tsource_hot + ' °C'),

							E('td', { 'class': 'td right top' }, E('strong', { 'class': 'graph_legend crit' }, _('Critical:'))),
							E('td', { 'class': 'td', 'id': 'temp_crit' }, tsource_crit + ' °C'),
						]),
					]),
					E('br'),
					tpoints_section || '',
					E('br'),
				]));

				this.updateGraph(tsource_path, csvg, [ { line: 'temp_line' } ], function(svg, info) {
					let G = svg.firstElementChild, tab = svg.parentNode;

					G.getElementById('label_25').firstChild.data = '%d °C'.format(info.label_25);
					G.getElementById('label_50').firstChild.data = '%d °C'.format(info.label_50);
					G.getElementById('label_75').firstChild.data = '%d °C'.format(info.label_75);

					tab.querySelector('#scale').firstChild.data = _('(%d minute window, %d second interval)').format(info.timeframe, info.interval);

					dom.content(tab.querySelector('#temp_cur'), '%.1f °C'.format(info.line_current[0], true));
					//dom.content(tab.querySelector('#temp_avg'), '%.1f °C'.format(info.line_average[0], true));
					dom.content(tab.querySelector('#temp_peak'), '%.1f °C'.format(info.line_peak[0], true));
				});
			}

			ui.tabs.initTabGroup(tabs.childNodes);
			this.pollData();
		};

		return  E([], [
			E('h2', _('Temperature')),
			E('div', {'class': 'cbi-map-descr'}, _('This page displays the temperature sensors data.')),
			map,
		]);
	},

	handleSaveApply: null,
	handleSave     : null,
	handleReset    : null,
});
