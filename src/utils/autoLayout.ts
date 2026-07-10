export type RiserCount = 1 | 2
export type SplitterSide = 'left' | 'right' | 'single'
export type SplitterRatio = 4 | 8

export interface FloorConfig {
  total: number
  left: number
}

export interface Splitter {
  id: string
  side: SplitterSide
  floor: number
  floorsServed: [number, number]
  ratio: SplitterRatio
}

export interface AutoLayoutResult {
  strict: Splitter[] | null
  nearestAbove: Splitter[] | null
  expandedTypes: Splitter[] | null
}

export const ALL_RATIOS: SplitterRatio[] = [4, 8]

// Верхняя граница «коридора» над целевым проникновением, %
const STRICT_CORRIDOR = 3

// Допуск на ошибки округления double при сравнении с границами коридора
// (ключи DP и так округляются до 6 знаков)
const EPS = 1e-6

// Средние проникновения сравниваем с точностью 1e-6 (как и ключи DP), чтобы
// планы, равные математически, но отличающиеся на ошибку округления double,
// считались равными и разрешались детерминированным тай-брейком.
const quantize = (value: number): number => Math.round(value * 1e6)

// Предохранитель для патологических конфигураций этажей: если состояний DP
// на этаж больше этого числа, оставляем ближайшие к цели (иначе перебор
// растёт экспоненциально и вкладка зависает).
const MAX_STATES_PER_FLOOR = 4000

export const getFloorApartmentCount = (
  config: FloorConfig | undefined,
  side: SplitterSide,
  riserCount: RiserCount
): number => {
  if (!config) return 0
  if (riserCount === 1 || side === 'single') return config.total
  return side === 'left' ? config.left : Math.max(config.total - config.left, 0)
}

export const getSplitterFloor = (start: number, end: number): number =>
  Math.floor((start + end) / 2)

export const getPlanAverage = (
  splitters: Splitter[],
  floorConfigs: FloorConfig[],
  riserCount: RiserCount
): number => {
  if (splitters.length === 0) return 0
  const total = splitters.reduce((sum, splitter) => {
    let apartments = 0
    for (let floor = splitter.floorsServed[0]; floor <= splitter.floorsServed[1]; floor++) {
      apartments += getFloorApartmentCount(floorConfigs[floor - 1], splitter.side, riserCount)
    }
    return sum + (apartments > 0 ? (splitter.ratio / apartments) * 100 : 0)
  }, 0)
  return total / splitters.length
}

// Состояние DP: план покрытия этажей 1..end одного стояка. Вместо копий
// массивов сплиттеров храним ссылку на родителя и последний сегмент —
// план восстанавливается только для победителя.
interface SideState {
  count: number
  penetrationSum: number
  ratioMask: number
  parent: SideState | null
  start: number
  end: number
  ratio: SplitterRatio
}

const stateKey = (state: SideState): string =>
  `${state.count}|${state.penetrationSum.toFixed(6)}|${state.ratioMask}`

const pruneBucket = (bucket: Map<string, SideState>, target: number): Map<string, SideState> => {
  if (bucket.size <= MAX_STATES_PER_FLOOR) return bucket
  const kept = [...bucket.entries()]
    .map((entry, index) => ({
      entry,
      index,
      penalty: Math.abs(entry[1].penetrationSum / entry[1].count - target),
    }))
    .sort((a, b) => a.penalty - b.penalty || a.index - b.index)
    .slice(0, MAX_STATES_PER_FLOOR)
    .sort((a, b) => a.index - b.index)
  return new Map(kept.map(({ entry }) => entry))
}

const buildSideStates = (
  side: SplitterSide,
  floorConfigs: FloorConfig[],
  riserCount: RiserCount,
  allowedRatios: SplitterRatio[],
  target: number
): SideState[] => {
  const floors = floorConfigs.length
  const buckets: Array<Map<string, SideState>> = Array.from({ length: floors + 1 }, () => new Map())
  buckets[0].set('0|0|0', {
    count: 0,
    penetrationSum: 0,
    ratioMask: 0,
    parent: null,
    start: 0,
    end: 0,
    ratio: 4,
  })

  for (let start = 1; start <= floors; start++) {
    buckets[start - 1] = pruneBucket(buckets[start - 1], target)
    for (const state of buckets[start - 1].values()) {
      let apartments = 0
      for (let end = start; end <= floors; end++) {
        apartments += getFloorApartmentCount(floorConfigs[end - 1], side, riserCount)
        if (apartments <= 0) continue
        for (const ratio of allowedRatios) {
          const next: SideState = {
            count: state.count + 1,
            penetrationSum: state.penetrationSum + (ratio / apartments) * 100,
            ratioMask: state.ratioMask | (ratio === 4 ? 1 : 2),
            parent: state,
            start,
            end,
            ratio,
          }
          const key = stateKey(next)
          const bucket = buckets[end]
          if (!bucket.has(key)) bucket.set(key, next)
        }
      }
    }
  }

  return [...pruneBucket(buckets[floors], target).values()]
}

const reconstructSide = (state: SideState | null, side: SplitterSide): Splitter[] => {
  const splitters: Splitter[] = []
  for (let current = state; current && current.parent; current = current.parent) {
    splitters.push({
      id: '',
      side,
      floor: getSplitterFloor(current.start, current.end),
      floorsServed: [current.start, current.end],
      ratio: current.ratio,
    })
  }
  return splitters.reverse()
}

interface CombinedCandidate {
  leftState: SideState
  rightState: SideState | null
  leftIndex: number
  rightIndex: number
  count: number
  penetrationSum: number
  ratioMask: number
}

interface RightGroup {
  count: number
  ratioMask: number
  // отсортированы по (penetrationSum, исходный индекс)
  entries: Array<{ sum: number; index: number; state: SideState | null }>
}

// Первый элемент группы с sum >= bound
const lowerBound = (entries: RightGroup['entries'], bound: number): number => {
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].sum >= bound) hi = mid
    else lo = mid + 1
  }
  return lo
}

const fitsMode = (average: number, target: number, mode: 'strict' | 'above'): boolean => {
  const qAverage = quantize(average)
  return mode === 'strict'
    ? qAverage >= quantize(target) && qAverage <= quantize(target + STRICT_CORRIDOR)
    : qAverage > quantize(target + STRICT_CORRIDOR)
}

// Ищем лучшие комбинации «план левого стояка + план правого стояка», не
// перебирая декартово произведение: правые планы группируются по
// (кол-во сплиттеров, набор типов) и внутри группы ищутся бинарным поиском.
const collectCandidates = (
  leftStates: SideState[],
  rightGroups: RightGroup[],
  target: number,
  mode: 'strict' | 'above'
): CombinedCandidate[] => {
  const bestByGroup = new Map<string, CombinedCandidate>()

  leftStates.forEach((leftState, leftIndex) => {
    for (const group of rightGroups) {
      const count = leftState.count + group.count
      if (count === 0) continue
      const lowestFit = mode === 'strict' ? target : target + STRICT_CORRIDOR
      const bound = lowestFit * count - leftState.penetrationSum - EPS * count

      // Минимальная сумма даёт минимальное среднее; из-за округления double
      // граничные элементы проверяем точным критерием со сдвигом вперёд.
      let at = lowerBound(group.entries, bound)
      let fit: { penetrationSum: number; entry: RightGroup['entries'][number] } | null = null
      for (; at < group.entries.length; at++) {
        const penetrationSum = leftState.penetrationSum + group.entries[at].sum
        const average = penetrationSum / count
        if (mode === 'strict' && quantize(average) > quantize(target + STRICT_CORRIDOR)) break
        if (fitsMode(average, target, mode)) {
          fit = { penetrationSum, entry: group.entries[at] }
          break
        }
      }
      if (!fit) continue

      const groupKey = `${leftState.count}|${leftState.ratioMask}|${group.count}|${group.ratioMask}`
      const best = bestByGroup.get(groupKey)
      if (!best || quantize(fit.penetrationSum) < quantize(best.penetrationSum)) {
        bestByGroup.set(groupKey, {
          leftState,
          rightState: fit.entry.state,
          leftIndex,
          rightIndex: fit.entry.index,
          count,
          penetrationSum: fit.penetrationSum,
          ratioMask: leftState.ratioMask | group.ratioMask,
        })
      }
    }
  })

  return [...bestByGroup.values()]
}

const pickBestCandidate = (
  candidates: CombinedCandidate[],
  leftSide: SplitterSide
): Splitter[] | null => {
  const ranked = candidates
    .map(candidate => ({
      candidate,
      qAverage: quantize(candidate.penetrationSum / candidate.count),
      mixed: candidate.ratioMask === 3,
    }))
    .sort((a, b) =>
      a.qAverage - b.qAverage
      || Number(a.mixed) - Number(b.mixed)
      || a.candidate.count - b.candidate.count
      || a.candidate.leftIndex - b.candidate.leftIndex
      || a.candidate.rightIndex - b.candidate.rightIndex
    )

  const best = ranked[0]?.candidate
  if (!best) return null
  return [
    ...reconstructSide(best.leftState, leftSide),
    ...reconstructSide(best.rightState, 'right'),
  ]
}

const assignSplitterIds = (splitters: Splitter[]): Splitter[] =>
  splitters.map((splitter, index) => ({ ...splitter, id: String(index + 1) }))

const buildRightGroups = (rightStates: Array<SideState | null>): RightGroup[] => {
  const groups = new Map<string, RightGroup>()
  rightStates.forEach((state, index) => {
    const count = state?.count ?? 0
    const ratioMask = state?.ratioMask ?? 0
    const key = `${count}|${ratioMask}`
    let group = groups.get(key)
    if (!group) {
      group = { count, ratioMask, entries: [] }
      groups.set(key, group)
    }
    group.entries.push({ sum: state?.penetrationSum ?? 0, index, state })
  })
  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.sum - b.sum || a.index - b.index)
  }
  return [...groups.values()]
}

const solveForRatios = (
  floorConfigs: FloorConfig[],
  riserCount: RiserCount,
  target: number,
  allowedRatios: SplitterRatio[]
) => {
  const singleRiser = riserCount === 1
  const leftSide: SplitterSide = singleRiser ? 'single' : 'left'
  const leftStates = buildSideStates(leftSide, floorConfigs, riserCount, allowedRatios, target)
  const rightStates: Array<SideState | null> = singleRiser
    ? [null]
    : buildSideStates('right', floorConfigs, riserCount, allowedRatios, target)
  if (leftStates.length === 0 || rightStates.length === 0) {
    return { strict: null, above: null }
  }

  const rightGroups = buildRightGroups(rightStates)
  const pick = (mode: 'strict' | 'above') => pickBestCandidate(
    collectCandidates(leftStates, rightGroups, target, mode),
    leftSide
  )

  return { strict: pick('strict'), above: pick('above') }
}

export const generateAutoLayout = (
  floorConfigs: FloorConfig[],
  riserCount: RiserCount,
  target: number,
  allowedRatios: SplitterRatio[]
): AutoLayoutResult => {
  const base = solveForRatios(floorConfigs, riserCount, target, allowedRatios)
  const expanded = allowedRatios.length === ALL_RATIOS.length
    ? base
    : solveForRatios(floorConfigs, riserCount, target, ALL_RATIOS)

  return {
    strict: base.strict ? assignSplitterIds(base.strict) : null,
    nearestAbove: base.above ? assignSplitterIds(base.above) : null,
    expandedTypes: expanded.strict ? assignSplitterIds(expanded.strict) : null,
  }
}
