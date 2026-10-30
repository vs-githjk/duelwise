import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LineChart } from './LineChart'

test('empty and populated charts have distinct identifiers and observe when points arrive', async () => {
  const props = { xLabels: ['a', 'b'], formatY: String, caption: 'Results', testId: 'winrate-chart' }
  const series = [{ key: 'x', label: 'X', color: 'red', values: [null, null] }]
  expect(renderToStaticMarkup(<LineChart {...props} series={series} />)).toContain('data-testid="winrate-chart-empty"')
  expect(renderToStaticMarkup(<LineChart {...props} series={[{ ...series[0]!, values: [0, 1] }]} />)).toContain('data-testid="winrate-chart"')
  const source = await Bun.file(new URL('./LineChart.tsx', import.meta.url)).text()
  expect(source).toContain('}, [hasPoints])')
})
