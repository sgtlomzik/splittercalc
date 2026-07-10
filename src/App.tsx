import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import {
  ALL_RATIOS,
  generateAutoLayout,
  type AutoLayoutResult,
  type FloorConfig,
  type RiserCount,
  type Splitter,
  type SplitterRatio,
  type SplitterSide,
} from './utils/autoLayout'

interface Entrance {
  id: string
  name: string
  startApartment: number
  totalApartments: number
  floors: number
  apartmentsPerFloor: number
  leftRiser: number
  riserCount: RiserCount
  floorConfigs: FloorConfig[]
  splitters: Splitter[]
  targetPenetration: number
  allowedRatios: SplitterRatio[]
}

interface FloorGroup {
  id: string
  from: number
  to: number
  total: number
  left: number
}

interface EntranceDraft {
  name: string
  floors: number
  totalApartments: number
  apartmentsPerFloor: number
  leftRiser: number
  riserCount: RiserCount
  targetPenetration: number
  allowedRatios: SplitterRatio[]
}

interface NumberInputProps {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  className: string
  title?: string
  integer?: boolean
}

const NumberInput = ({ value, onValueChange, min, max, className, title, integer = true }: NumberInputProps) => {
  const [text, setText] = useState(String(value))

  useEffect(() => {
    setText(String(value))
  }, [value])

  const commit = (nextText: string) => {
    setText(nextText)
    if (nextText === '') return

    const parsed = Number(nextText)
    if (!Number.isFinite(parsed)) return

    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed))
    const nextValue = integer ? Math.trunc(clamped) : clamped
    onValueChange(nextValue)
  }

  return (
    <input
      type="number"
      step={integer ? 1 : 'any'}
      min={min}
      max={max}
      value={text}
      title={title}
      onChange={(e) => commit(e.target.value)}
      onBlur={() => {
        // Показываем итоговое (клампнутое) значение, даже если родитель
        // не изменил value и эффект синхронизации не сработал
        setText(String(value))
      }}
      className={className}
    />
  )
}

interface DragState {
  splitterId: string
  type: 'move' | 'resize-top' | 'resize-bottom'
  startY: number
  originalFloor?: number
  originalFloorsServed?: [number, number]
}

const defaultFloorConfigs = (
  floors: number,
  perFloor: number,
  leftRiser: number,
  total: number,
  riserCount: RiserCount = 2
): FloorConfig[] => {
  const configs: FloorConfig[] = []
  const regularFloors = floors - 1
  const firstFloorApts = Math.max(0, total - (regularFloors * perFloor))

  for (let i = 1; i <= floors; i++) {
    const floorTotal = i === 1 ? firstFloorApts : perFloor
    if (i === 1) {
      const firstLeft = riserCount === 1 ? floorTotal : Math.min(leftRiser, firstFloorApts)
      configs.push({ total: floorTotal, left: firstLeft })
    } else {
      configs.push({ total: floorTotal, left: riserCount === 1 ? floorTotal : Math.min(leftRiser, floorTotal) })
    }
  }
  return configs
}

const createDefaultGroups = (
  floors: number,
  perFloor: number,
  leftRiser: number,
  total: number,
  riserCount: RiserCount
): FloorGroup[] => {
  const firstFloorApts = Math.max(0, total - ((floors - 1) * perFloor))
  const groups: FloorGroup[] = []

  if (floors <= 0) return groups
  groups.push({
    id: 'first',
    from: 1,
    to: 1,
    total: firstFloorApts,
    left: riserCount === 1 ? firstFloorApts : Math.min(leftRiser, firstFloorApts),
  })

  if (floors > 1) {
    groups.push({
      id: 'regular',
      from: 2,
      to: floors,
      total: perFloor,
      left: riserCount === 1 ? perFloor : Math.min(leftRiser, perFloor),
    })
  }

  return groups
}

const groupsToFloorConfigs = (floors: number, riserCount: RiserCount, groups: FloorGroup[]): FloorConfig[] => {
  const configs = Array.from({ length: floors }, () => ({ total: 0, left: 0 }))

  groups.forEach(group => {
    const from = Math.max(1, Math.min(floors, group.from))
    const to = Math.max(from, Math.min(floors, group.to))
    for (let floor = from; floor <= to; floor++) {
      const total = Math.max(0, group.total)
      configs[floor - 1] = {
        total,
        left: riserCount === 1 ? total : Math.max(0, Math.min(group.left, total)),
      }
    }
  })

  return configs
}

const floorConfigsToGroups = (configs: FloorConfig[], riserCount: RiserCount): FloorGroup[] => {
  if (configs.length === 0) return []

  const groups: FloorGroup[] = []
  let start = 1
  let prev = configs[0]

  for (let i = 1; i <= configs.length; i++) {
    const current = configs[i]
    const same = current && current.total === prev.total && (riserCount === 1 || current.left === prev.left)
    if (same) continue

    groups.push({
      id: `${start}-${i}`,
      from: start,
      to: i,
      total: prev.total,
      left: riserCount === 1 ? prev.total : prev.left,
    })
    start = i + 1
    prev = current
  }

  return groups
}

const normalizeSplittersForRiserCount = (splitters: Splitter[], riserCount: RiserCount): Splitter[] => {
  if (riserCount === 1) {
    const normalized: Splitter[] = []

    splitters.forEach(splitter => {
      let segments: [number, number][] = [[splitter.floorsServed[0], splitter.floorsServed[1]]]

      normalized.forEach(kept => {
        const [keptStart, keptEnd] = kept.floorsServed
        segments = segments.flatMap(([start, end]) => {
          if (end < keptStart || start > keptEnd) return [[start, end] as [number, number]]
          const next: [number, number][] = []
          if (start < keptStart) next.push([start, keptStart - 1])
          if (end > keptEnd) next.push([keptEnd + 1, end])
          return next
        })
      })

      if (segments.length === 0) return

      const segment = segments.find(([start, end]) => splitter.floor >= start && splitter.floor <= end)
        || segments.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0]
      normalized.push({
        ...splitter,
        side: 'single',
        floor: Math.max(segment[0], Math.min(segment[1], splitter.floor)),
        floorsServed: segment,
      })
    })

    return normalized
  }
  return splitters.map(s => ({ ...s, side: s.side === 'single' ? 'left' : s.side }))
}

// Начала нумерации квартир следуют подряд за предыдущими парадными
const renumberEntrances = (entrances: Entrance[]): Entrance[] => {
  let startApartment = 1
  return entrances.map(entrance => {
    const updated = entrance.startApartment === startApartment
      ? entrance
      : { ...entrance, startApartment }
    startApartment += entrance.totalApartments
    return updated
  })
}

const clampSplittersToFloors = (splitters: Splitter[], floors: number): Splitter[] =>
  splitters
    .filter(splitter => splitter.floorsServed[0] <= floors)
    .map(splitter => splitter.floorsServed[1] <= floors
      ? splitter
      : {
          ...splitter,
          floor: Math.min(splitter.floor, floors),
          floorsServed: [splitter.floorsServed[0], floors] as [number, number],
        })

// Обрезает/разбивает сплиттеры того же стояка, пересекающиеся с зоной target
const resolveOverlaps = (splitters: Splitter[], target: Splitter): Splitter[] => {
  const [targetStart, targetEnd] = target.floorsServed

  return splitters.flatMap(splitter => {
    if (splitter.id === target.id || splitter.side !== target.side) return [splitter]

    const [otherStart, otherEnd] = splitter.floorsServed
    if (otherStart > targetEnd || targetStart > otherEnd) return [splitter]

    const leftSegment: [number, number] = [otherStart, targetStart - 1]
    const rightSegment: [number, number] = [targetEnd + 1, otherEnd]
    const hasLeft = leftSegment[0] <= leftSegment[1]
    const hasRight = rightSegment[0] <= rightSegment[1]

    if (!hasLeft && !hasRight) return []
    if (hasLeft && !hasRight) {
      return [{ ...splitter, floor: Math.min(splitter.floor, leftSegment[1]), floorsServed: leftSegment }]
    }
    if (!hasLeft && hasRight) {
      return [{ ...splitter, floor: Math.max(splitter.floor, rightSegment[0]), floorsServed: rightSegment }]
    }

    const keptSegment = splitter.floor <= leftSegment[1] ? leftSegment : rightSegment
    const keptFloor = Math.max(keptSegment[0], Math.min(keptSegment[1], splitter.floor))
    return [{ ...splitter, floor: keptFloor, floorsServed: keptSegment }]
  })
}

const createEntrance = (id: string, name: string, startApt: number, template?: Partial<Entrance>): Entrance => {
  const floors = template?.floors || 12
  const perFloor = template?.apartmentsPerFloor || 5
  const leftRiser = template?.leftRiser || 3
  const total = template?.totalApartments || 59
  const riserCount = template?.riserCount || 2
  const targetPenetration = template?.targetPenetration ?? 40
  const allowedRatios = template?.allowedRatios ?? ALL_RATIOS
  const floorConfigs = template?.floorConfigs || defaultFloorConfigs(floors, perFloor, leftRiser, total, riserCount)
  const autoLayout = generateAutoLayout(floorConfigs, riserCount, targetPenetration, allowedRatios)
  
  return {
    id,
    name,
    startApartment: startApt,
    totalApartments: total,
    floors,
    apartmentsPerFloor: perFloor,
    leftRiser,
    riserCount,
    floorConfigs,
    splitters: template?.splitters || autoLayout.strict || autoLayout.nearestAbove || autoLayout.expandedTypes || [],
    targetPenetration,
    allowedRatios,
  }
}

export default function App() {
  // Ленивый инициализатор обязателен: createEntrance запускает автоподбор,
  // и без него тяжёлый расчёт выполнялся бы на каждом рендере
  const [entrances, setEntrances] = useState<Entrance[]>(() => [
    createEntrance('1', 'Парадная 1', 1)
  ])
  const [activeEntranceId, setActiveEntranceId] = useState('1')
  const [selectedSplitter, setSelectedSplitter] = useState<string | null>(null)
  const [hoveredApartment, setHoveredApartment] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddEntrance, setShowAddEntrance] = useState(false)
  const [editingSplitter, setEditingSplitter] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; splitterId: string } | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [copiedText, setCopiedText] = useState<string | null>(null)
  const [floorGroups, setFloorGroups] = useState<FloorGroup[]>([])
  const [autoLayoutMessage, setAutoLayoutMessage] = useState<string | null>(null)
  const [autoLayoutFallbacks, setAutoLayoutFallbacks] = useState<AutoLayoutResult | null>(null)
  const [entranceDraft, setEntranceDraft] = useState<EntranceDraft>({
    name: 'Парадная 2',
    floors: 12,
    totalApartments: 59,
    apartmentsPerFloor: 5,
    leftRiser: 3,
    riserCount: 2,
    targetPenetration: 40,
    allowedRatios: ALL_RATIOS,
  })
  
  const schemaRef = useRef<HTMLDivElement>(null)
  
  const activeEntrance = entrances.find(e => e.id === activeEntranceId)!
  const isSingleRiser = activeEntrance.riserCount === 1
  const apartmentCellWidth = 40
  const apartmentGapWidth = 2
  const apartmentAreaWidth = (count: number) =>
    count > 0 ? count * apartmentCellWidth + (count - 1) * apartmentGapWidth : 0
  const maxLeftApts = Math.max(0, ...activeEntrance.floorConfigs.map(config => config.left))
  const maxRightApts = Math.max(
    0,
    ...activeEntrance.floorConfigs.map(config => Math.max(config.total - config.left, 0))
  )
  const leftApartmentsWidth = apartmentAreaWidth(maxLeftApts)
  const rightApartmentsWidth = apartmentAreaWidth(maxRightApts)
  const maxSingleApts = Math.max(0, ...activeEntrance.floorConfigs.map(config => config.total))
  const singleApartmentsWidth = apartmentAreaWidth(maxSingleApts)
  
  const totalStats = useMemo(() => ({
    entrances: entrances.length,
    floors: Math.max(...entrances.map(ent => ent.floors)),
    apartments: entrances.reduce((sum, ent) => sum + ent.totalApartments, 0),
    risers: entrances.reduce((sum, ent) => sum + ent.riserCount, 0),
    splitters: entrances.reduce((sum, ent) => sum + ent.splitters.length, 0),
  }), [entrances])
  const getApartmentsForFloor = (entrance: Entrance, floor: number, side: SplitterSide): number[] => {
    let startApt = entrance.startApartment

    // именно ??, а не ||: этаж с 0 квартир (или 0 на левом стояке) корректен
    for (let f = 1; f < floor; f++) {
      startApt += entrance.floorConfigs[f - 1]?.total ?? entrance.apartmentsPerFloor
    }

    const config = entrance.floorConfigs[floor - 1]
    const total = config?.total ?? entrance.apartmentsPerFloor
    const left = config?.left ?? entrance.leftRiser
    
    const apartments: number[] = []
    if (entrance.riserCount === 1 || side === 'single') {
      for (let i = 0; i < total; i++) {
        apartments.push(startApt + i)
      }
    } else if (side === 'left') {
      for (let i = 0; i < left; i++) {
        apartments.push(startApt + i)
      }
    } else {
      for (let i = left; i < total; i++) {
        apartments.push(startApt + i)
      }
    }
    return apartments
  }

  const getApartmentsForSplitter = (entrance: Entrance, splitter: Splitter): number[] => {
    const apartments: number[] = []
    for (let floor = splitter.floorsServed[0]; floor <= splitter.floorsServed[1]; floor++) {
      if (floor >= 1 && floor <= entrance.floors) {
        apartments.push(...getApartmentsForFloor(entrance, floor, splitter.side))
      }
    }
    return apartments.sort((a, b) => a - b)
  }

  const apartmentsBySplitterId = useMemo(
    () => Object.fromEntries(
      activeEntrance.splitters.map(splitter => [splitter.id, getApartmentsForSplitter(activeEntrance, splitter)])
    ) as Record<string, number[]>,
    [activeEntrance]
  )

  const splitterInfoByApartment = useMemo(() => {
    const map = new Map<number, { splitter: Splitter; index: number }>()
    activeEntrance.splitters.forEach((splitter, index) => {
      apartmentsBySplitterId[splitter.id]?.forEach(apartment => map.set(apartment, { splitter, index }))
    })
    return map
  }, [activeEntrance.splitters, apartmentsBySplitterId])

  const formatApartmentRanges = (apartments: number[]): string => {
    if (apartments.length === 0) return ''
    
    const sorted = [...apartments].sort((a, b) => a - b)
    const ranges: string[] = []
    let start = sorted[0]
    let end = sorted[0]
    
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i]
      } else {
        ranges.push(start === end ? `${start}` : `${start}-${end}`)
        start = sorted[i]
        end = sorted[i]
      }
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`)
    
    return ranges.join(', ') + 'кв.'
  }

  const getSplitterColor = (index: number): string => {
    const colors = [
      'bg-blue-600', 'bg-emerald-600', 'bg-amber-600', 
      'bg-purple-600', 'bg-rose-600', 'bg-cyan-600',
      'bg-indigo-600', 'bg-orange-600'
    ]
    return colors[index % colors.length]
  }

  const getSplitterLabel = (splitter: Splitter): string => {
    if (activeEntrance.riserCount === 1 || splitter.side === 'single') {
      return `${splitter.floor}`
    }
    return `${splitter.side === 'left' ? 'Л' : 'П'}-${splitter.floor}`
  }

  const getMedian = (values: number[]): number => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }

  const getPenetrationVisual = (penetration: number, median: number) => {
    const isGood = penetration >= 40 && penetration <= 60
    const isCritical = penetration < 30 || penetration > 70
    const isOutlier = Math.abs(penetration - median) >= 15
    const tone = isGood ? 'good' : isCritical ? 'bad' : 'warn'

    return {
      cardClass:
        tone === 'good'
          ? 'bg-emerald-900/70 border border-emerald-500/70'
          : tone === 'warn'
            ? 'bg-amber-900/70 border border-amber-500/70'
            : 'bg-red-900/70 border border-red-500/80',
      textClass: tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-red-300',
      outlierClass: isOutlier ? 'ring-2 ring-red-400/90' : '',
      label: isOutlier ? 'Выброс' : '',
    }
  }

  

  const updateEntrance = (updates: Partial<Entrance>) => {
    setEntrances(prev => renumberEntrances(prev.map(e =>
      e.id === activeEntranceId ? { ...e, ...updates } : e
    )))
  }

  const updateSplitter = (splitterId: string, updates: Partial<Splitter>) => {
    updateEntrance({
      splitters: activeEntrance.splitters.map(s =>
        s.id === splitterId ? { ...s, ...updates } : s
      )
    })
  }

  // Любое изменение зоны или стояка проходит через разрешение перекрытий,
  // иначе появляются «невидимые» сплиттеры, спрятанные под соседними
  const updateSplitterResolved = (splitterId: string, updates: Partial<Splitter>) => {
    const current = activeEntrance.splitters.find(s => s.id === splitterId)
    if (!current) return

    const merged = { ...current, ...updates }
    const [start, end] = merged.floorsServed
    const next: Splitter = { ...merged, floor: Math.max(start, Math.min(end, merged.floor)) }
    const replaced = activeEntrance.splitters.map(s => (s.id === splitterId ? next : s))
    updateEntrance({ splitters: resolveOverlaps(replaced, next) })
  }

  const addSplitter = (side: SplitterSide, floor: number) => {
    const newSplitter: Splitter = {
      id: Date.now().toString(),
      side,
      floor,
      floorsServed: [Math.max(1, floor - 1), Math.min(activeEntrance.floors, floor + 1)],
      ratio: 8
    }
    updateEntrance({
      splitters: resolveOverlaps([...activeEntrance.splitters, newSplitter], newSplitter),
    })
  }

  const deleteSplitter = (splitterId: string) => {
    updateEntrance({ splitters: activeEntrance.splitters.filter(s => s.id !== splitterId) })
    setEditingSplitter(null)
    setContextMenu(null)
  }

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedText(text)
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    copyTimeoutRef.current = setTimeout(() => setCopiedText(null), 2000)
  }

  const openSettings = () => {
    setFloorGroups(floorConfigsToGroups(activeEntrance.floorConfigs, activeEntrance.riserCount))
    setAutoLayoutMessage(null)
    setAutoLayoutFallbacks(null)
    setShowSettings(true)
  }

  const openAddEntrance = () => {
    setEntranceDraft({
      name: `Парадная ${entrances.length + 1}`,
      floors: activeEntrance.floors,
      totalApartments: activeEntrance.totalApartments,
      apartmentsPerFloor: activeEntrance.apartmentsPerFloor,
      leftRiser: activeEntrance.leftRiser,
      riserCount: activeEntrance.riserCount,
      targetPenetration: activeEntrance.targetPenetration,
      allowedRatios: activeEntrance.allowedRatios,
    })
    setFloorGroups(createDefaultGroups(
      activeEntrance.floors,
      activeEntrance.apartmentsPerFloor,
      activeEntrance.leftRiser,
      activeEntrance.totalApartments,
      activeEntrance.riserCount
    ))
    setShowAddEntrance(true)
  }

  const updateFloorGroup = (id: string, updates: Partial<FloorGroup>) => {
    setFloorGroups(groups => groups.map(group => {
      if (group.id !== id) return group
      const next = { ...group, ...updates }
      return {
        ...next,
        to: Math.max(next.from, next.to),
        left: Math.max(0, Math.min(next.left, next.total)),
      }
    }))
  }

  const addFloorGroup = (riserCount: RiserCount) => {
    const last = floorGroups[floorGroups.length - 1]
    const from = last ? last.to + 1 : 1
    const to = last ? last.to + 1 : 1
    const total = last?.total || 5
    setFloorGroups(groups => [
      ...groups,
      {
        id: Date.now().toString(),
        from,
        to,
        total,
        left: riserCount === 1 ? total : Math.min(last?.left || 3, total),
      },
    ])
  }

  const removeFloorGroup = (id: string) => {
    setFloorGroups(groups => groups.filter(group => group.id !== id))
  }

  const applyActiveFloorGroups = () => {
    const configs = groupsToFloorConfigs(activeEntrance.floors, activeEntrance.riserCount, floorGroups)
    updateEntrance({
      floorConfigs: configs,
      totalApartments: configs.reduce((sum, config) => sum + config.total, 0),
    })
  }

  const updateActiveRiserCount = (riserCount: RiserCount) => {
    const groups = (floorGroups.length ? floorGroups : floorConfigsToGroups(activeEntrance.floorConfigs, activeEntrance.riserCount))
      .map(group => ({
        ...group,
        left: riserCount === 1 ? group.total : Math.min(group.left, group.total),
      }))
    const configs = groupsToFloorConfigs(activeEntrance.floors, riserCount, groups)

    setFloorGroups(groups)
    updateEntrance({
      riserCount,
      leftRiser: riserCount === 1 ? activeEntrance.apartmentsPerFloor : activeEntrance.leftRiser,
      floorConfigs: configs,
      totalApartments: configs.reduce((sum, config) => sum + config.total, 0),
      splitters: normalizeSplittersForRiserCount(activeEntrance.splitters, riserCount),
    })
  }

  const addEntrance = () => {
    const lastEntrance = entrances[entrances.length - 1]
    const startApt = lastEntrance.startApartment + lastEntrance.totalApartments
    const newId = Date.now().toString()
    const configs = groupsToFloorConfigs(entranceDraft.floors, entranceDraft.riserCount, floorGroups)
    const totalApartments = configs.reduce((sum, config) => sum + config.total, 0) || entranceDraft.totalApartments
    const name = entranceDraft.name.trim() || `Парадная ${entrances.length + 1}`
    const newEntrance = createEntrance(newId, name, startApt, {
      totalApartments,
      floors: entranceDraft.floors,
      apartmentsPerFloor: entranceDraft.apartmentsPerFloor,
      leftRiser: entranceDraft.riserCount === 1 ? entranceDraft.apartmentsPerFloor : entranceDraft.leftRiser,
      riserCount: entranceDraft.riserCount,
      targetPenetration: entranceDraft.targetPenetration,
      allowedRatios: entranceDraft.allowedRatios,
      floorConfigs: configs.length ? configs : defaultFloorConfigs(
        entranceDraft.floors,
        entranceDraft.apartmentsPerFloor,
        entranceDraft.leftRiser,
        entranceDraft.totalApartments,
        entranceDraft.riserCount
      ),
    })
    
    setEntrances(renumberEntrances([...entrances, newEntrance]))
    setActiveEntranceId(newId)
    setShowAddEntrance(false)
  }

  const getAutoLayoutResult = (
    floorConfigs: FloorConfig[],
    riserCount: RiserCount,
    targetPenetration: number,
    allowedRatios: SplitterRatio[]
  ) => generateAutoLayout(
    floorConfigs,
    riserCount,
    Math.max(0, targetPenetration),
    allowedRatios.length ? allowedRatios : [8]
  )

  const applyAutoLayout = () => {
    const result = getAutoLayoutResult(
      activeEntrance.floorConfigs,
      activeEntrance.riserCount,
      activeEntrance.targetPenetration,
      activeEntrance.allowedRatios
    )
    if (result.strict) {
      updateEntrance({ splitters: result.strict })
      setAutoLayoutMessage('Автоподбор применён: найдена строгая схема.')
      setAutoLayoutFallbacks(null)
      return
    }

    setAutoLayoutMessage('Строгой схемы нет. Можно выбрать ближайший вариант или расширить типы сплиттеров.')
    setAutoLayoutFallbacks(result)
  }

  const applyFallbackLayout = (kind: 'nearestAbove' | 'expandedTypes') => {
    // Варианты уже посчитаны в applyAutoLayout — не пересчитываем заново
    const next = autoLayoutFallbacks?.[kind]
    if (!next) return

    updateEntrance({
      splitters: next,
      allowedRatios: kind === 'expandedTypes' ? ALL_RATIOS : activeEntrance.allowedRatios,
    })
    setAutoLayoutFallbacks(null)
    setAutoLayoutMessage(kind === 'expandedTypes'
      ? 'Применён вариант с расширенным набором типов.'
      : 'Применён ближайший вариант выше допустимого коридора.')
  }

  const toggleAllowedRatio = (ratio: SplitterRatio, draft = false) => {
    if (draft) {
      const next = entranceDraft.allowedRatios.includes(ratio)
        ? entranceDraft.allowedRatios.filter(value => value !== ratio)
        : [...entranceDraft.allowedRatios, ratio].sort((a, b) => a - b)
      setEntranceDraft({ ...entranceDraft, allowedRatios: next.length ? next : [ratio] })
      return
    }

    const next = activeEntrance.allowedRatios.includes(ratio)
      ? activeEntrance.allowedRatios.filter(value => value !== ratio)
      : [...activeEntrance.allowedRatios, ratio].sort((a, b) => a - b)
    updateEntrance({ allowedRatios: next.length ? next : [ratio] })
  }

  const deleteEntrance = (entranceId: string) => {
    if (entrances.length <= 1) return
    const recalculated = renumberEntrances(entrances.filter(ent => ent.id !== entranceId))

    setEntrances(recalculated)
    if (activeEntranceId === entranceId) {
      setActiveEntranceId(recalculated[0].id)
    }
  }

  // Drag handlers for zone resizing
  const handleMouseDown = useCallback((e: React.MouseEvent, splitterId: string, type: DragState['type']) => {
    e.preventDefault()
    e.stopPropagation()
    const splitter = activeEntrance.splitters.find(s => s.id === splitterId)
    if (!splitter) return
    
    setDragState({
      splitterId,
      type,
      startY: e.clientY,
      originalFloor: splitter.floor,
      originalFloorsServed: [...splitter.floorsServed] as [number, number],
    })
  }, [activeEntrance.splitters])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragState || !schemaRef.current) return

    const floorHeight = 58 // высота ряда (h-14 = 56px) + межэтажный зазор (gap-0.5 = 2px)
    const deltaY = dragState.startY - e.clientY
    const floorDelta = Math.round(deltaY / floorHeight)

    const splitter = activeEntrance.splitters.find(s => s.id === dragState.splitterId)
    if (!splitter || !dragState.originalFloorsServed) return

    if (dragState.type === 'resize-top') {
      const newTop = Math.min(
        activeEntrance.floors,
        Math.max(splitter.floorsServed[0], dragState.originalFloorsServed[1] + floorDelta)
      )
      if (newTop !== splitter.floorsServed[1]) {
        updateSplitterResolved(dragState.splitterId, {
          floorsServed: [splitter.floorsServed[0], newTop],
        })
      }
    } else if (dragState.type === 'resize-bottom') {
      const newBottom = Math.min(
        splitter.floorsServed[1],
        Math.max(1, dragState.originalFloorsServed[0] + floorDelta)
      )
      if (newBottom !== splitter.floorsServed[0]) {
        updateSplitterResolved(dragState.splitterId, {
          floorsServed: [newBottom, splitter.floorsServed[1]],
        })
      }
    } else if (dragState.type === 'move' && dragState.originalFloor) {
      // Не даём зоне «сплющиваться» у краёв дома: смещение ограничено так,
      // чтобы весь диапазон этажей помещался целиком
      const [origStart, origEnd] = dragState.originalFloorsServed
      const offset = Math.max(1 - origStart, Math.min(activeEntrance.floors - origEnd, floorDelta))
      const newFloor = dragState.originalFloor + offset
      if (newFloor !== splitter.floor) {
        updateSplitterResolved(dragState.splitterId, {
          floor: newFloor,
          floorsServed: [origStart + offset, origEnd + offset],
        })
      }
    }
  }, [dragState, activeEntrance])

  const handleMouseUp = useCallback(() => {
    setDragState(null)
  }, [])

  useEffect(() => {
    if (dragState) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [dragState, handleMouseMove, handleMouseUp])

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    if (contextMenu) {
      window.addEventListener('click', handleClick)
      return () => window.removeEventListener('click', handleClick)
    }
  }, [contextMenu])

  const getSplitterForApartment = (apt: number): { splitter: Splitter; index: number } | null =>
    splitterInfoByApartment.get(apt) ?? null

  const renderFloor = (floor: number) => {
    const singleApts = isSingleRiser ? getApartmentsForFloor(activeEntrance, floor, 'single') : []
    const leftApts = isSingleRiser ? [] : getApartmentsForFloor(activeEntrance, floor, 'left')
    const rightApts = isSingleRiser ? [] : getApartmentsForFloor(activeEntrance, floor, 'right')
    
    const leftSplitters = activeEntrance.splitters.filter(s => 
      s.side === 'left' && floor >= s.floorsServed[0] && floor <= s.floorsServed[1]
    )
    const rightSplitters = activeEntrance.splitters.filter(s => 
      s.side === 'right' && floor >= s.floorsServed[0] && floor <= s.floorsServed[1]
    )
    const singleSplitters = activeEntrance.splitters.filter(s =>
      s.side === 'single' && floor >= s.floorsServed[0] && floor <= s.floorsServed[1]
    )
    
    const leftSplitter = leftSplitters[0]
    const rightSplitter = rightSplitters[0]
    const singleSplitter = singleSplitters[0]
    
    const leftSplitterIndex = leftSplitter ? activeEntrance.splitters.indexOf(leftSplitter) : -1
    const rightSplitterIndex = rightSplitter ? activeEntrance.splitters.indexOf(rightSplitter) : -1
    const singleSplitterIndex = singleSplitter ? activeEntrance.splitters.indexOf(singleSplitter) : -1

    const renderApartment = (apt: number) => {
      const splitterInfo = getSplitterForApartment(apt)
      const isSelected = selectedSplitter && splitterInfo?.splitter.id === selectedSplitter
      const isHovered = hoveredApartment === apt
      
      return (
        <div
          key={apt}
          className={`
            w-10 h-10 flex items-center justify-center text-xs font-mono
            border border-zinc-700 cursor-pointer transition-all
            ${isSelected ? getSplitterColor(splitterInfo?.index || 0) + ' text-white' : 'bg-zinc-800 text-zinc-300'}
            ${isHovered ? 'ring-2 ring-white' : ''}
          `}
          onMouseEnter={() => setHoveredApartment(apt)}
          onMouseLeave={() => setHoveredApartment(null)}
          onClick={() => splitterInfo && setSelectedSplitter(splitterInfo.splitter.id)}
        >
          {apt}
        </div>
      )
    }

    const renderSplitterZone = (side: SplitterSide, splitter: Splitter | undefined, splitterIndex: number) => {
      if (!splitter) {
        return (
          <div 
            data-testid={`splitter-zone-${side}-${floor}`}
            className="w-6 h-full flex items-center justify-center cursor-pointer hover:bg-zinc-700 transition-colors"
            onClick={() => addSplitter(side, floor)}
            title="Добавить сплиттер"
          >
            <span className="text-zinc-600 text-lg">+</span>
          </div>
        )
      }

      const isTop = floor === splitter.floorsServed[1]
      const isBottom = floor === splitter.floorsServed[0]
      const isSplitterFloor = floor === splitter.floor
      const isSelected = selectedSplitter === splitter.id
      const isEditing = editingSplitter === splitter.id

      return (
        <div 
          data-testid={`splitter-zone-${side}-${floor}`}
          className={`
            w-6 h-full relative flex items-center justify-center
            ${getSplitterColor(splitterIndex)} 
            ${isSelected ? 'ring-2 ring-white' : ''}
            ${isTop ? 'rounded-t' : ''} ${isBottom ? 'rounded-b' : ''}
            cursor-pointer transition-all
          `}
          onClick={(e) => {
            e.stopPropagation()
            setSelectedSplitter(splitter.id)
            setEditingSplitter(splitter.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setContextMenu({ x: e.clientX, y: e.clientY, splitterId: splitter.id })
          }}
        >
          {/* Resize handle top */}
          {isTop && (
            <div
              className="absolute -top-1 left-0 right-0 h-3 cursor-ns-resize hover:bg-white/30 z-10"
              onMouseDown={(e) => handleMouseDown(e, splitter.id, 'resize-top')}
            />
          )}
          
          {/* Resize handle bottom */}
          {isBottom && (
            <div
              className="absolute -bottom-1 left-0 right-0 h-3 cursor-ns-resize hover:bg-white/30 z-10"
              onMouseDown={(e) => handleMouseDown(e, splitter.id, 'resize-bottom')}
            />
          )}
          
          {/* Splitter label on its floor */}
          {isSplitterFloor && (
            <div 
              className="text-[10px] text-white font-bold cursor-move"
              onMouseDown={(e) => handleMouseDown(e, splitter.id, 'move')}
            >
              1/{splitter.ratio}
            </div>
          )}

          {/* Inline editor */}
          {isEditing && isSplitterFloor && (
            <div 
              className="absolute left-8 top-0 bg-zinc-900 border border-zinc-600 rounded p-2 z-50 shadow-xl min-w-48"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-xs text-zinc-400 mb-2">
                Сплиттер {side === 'single' ? floor : `${side === 'left' ? 'Л' : 'П'}-${floor}`}
              </div>
              
              <div className="flex gap-2 mb-2">
                <button
                  className={`px-2 py-1 text-xs rounded ${splitter.ratio === 4 ? 'bg-blue-600' : 'bg-zinc-700'}`}
                  onClick={() => updateSplitter(splitter.id, { ratio: 4 })}
                >
                  1/4
                </button>
                <button
                  className={`px-2 py-1 text-xs rounded ${splitter.ratio === 8 ? 'bg-blue-600' : 'bg-zinc-700'}`}
                  onClick={() => updateSplitter(splitter.id, { ratio: 8 })}
                >
                  1/8
                </button>
              </div>
              
              <div className="flex gap-2 mb-2">
                <div className="flex-1">
                  <label className="text-[10px] text-zinc-500">С этажа</label>
                  <NumberInput
                    min={1}
                    max={splitter.floorsServed[1]}
                    value={splitter.floorsServed[0]}
                    onValueChange={(value) => updateSplitterResolved(splitter.id, { floorsServed: [value, splitter.floorsServed[1]] })}
                    className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-zinc-500">По этаж</label>
                  <NumberInput
                    min={splitter.floorsServed[0]}
                    max={activeEntrance.floors}
                    value={splitter.floorsServed[1]}
                    onValueChange={(value) => updateSplitterResolved(splitter.id, { floorsServed: [splitter.floorsServed[0], value] })}
                    className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs"
                  />
                </div>
              </div>

              {!isSingleRiser && (
                <div className="flex gap-2 mb-2">
                  <button
                    className={`flex-1 px-2 py-1 text-xs rounded ${splitter.side === 'left' ? 'bg-blue-600' : 'bg-zinc-700'}`}
                    onClick={() => updateSplitterResolved(splitter.id, { side: 'left' })}
                  >
                    Левый
                  </button>
                  <button
                    className={`flex-1 px-2 py-1 text-xs rounded ${splitter.side === 'right' ? 'bg-blue-600' : 'bg-zinc-700'}`}
                    onClick={() => updateSplitterResolved(splitter.id, { side: 'right' })}
                  >
                    Правый
                  </button>
                </div>
              )}
              
              <div className="flex gap-2">
                <button
                  className="flex-1 px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-500"
                  onClick={() => deleteSplitter(splitter.id)}
                >
                  Удалить
                </button>
                <button
                  className="flex-1 px-2 py-1 text-xs rounded bg-zinc-600 hover:bg-zinc-500"
                  onClick={() => setEditingSplitter(null)}
                >
                  Закрыть
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

    if (isSingleRiser) {
      return (
        <div
          key={floor}
          className="grid items-stretch h-14"
          style={{
            gridTemplateColumns: `32px 24px ${singleApartmentsWidth}px`,
            columnGap: '4px',
          }}
        >
          <div className="w-8 flex items-center justify-center text-xs text-zinc-500 font-mono">
            {floor}
          </div>
          {renderSplitterZone('single', singleSplitter, singleSplitterIndex)}
          <div className="flex gap-0.5" style={{ width: singleApartmentsWidth }}>
            {singleApts.map(renderApartment)}
          </div>
        </div>
      )
    }

    return (
      <div
        key={floor}
        className="grid items-stretch h-14"
        style={{
          gridTemplateColumns: `32px 24px ${leftApartmentsWidth}px 9px ${rightApartmentsWidth}px 24px`,
          columnGap: '4px',
        }}
      >
        {/* Floor number */}
        <div className="w-8 flex items-center justify-center text-xs text-zinc-500 font-mono">
          {floor}
        </div>
        
        {/* Left splitter zone */}
        {renderSplitterZone('left', leftSplitter, leftSplitterIndex)}
        
        {/* Left apartments */}
        <div className="flex gap-0.5" style={{ width: leftApartmentsWidth }}>
          {leftApts.map(renderApartment)}
        </div>
        
        {/* Separator */}
        <div className="w-px bg-zinc-700 mx-1" />
        
        {/* Right apartments */}
        <div className="flex gap-0.5" style={{ width: rightApartmentsWidth }}>
          {rightApts.map(renderApartment)}
        </div>
        
        {/* Right splitter zone */}
        {renderSplitterZone('right', rightSplitter, rightSplitterIndex)}
      </div>
    )
  }

  const selectedSplitterData = selectedSplitter 
    ? activeEntrance.splitters.find(s => s.id === selectedSplitter)
    : null
  const selectedSplitterIndex = selectedSplitterData 
    ? activeEntrance.splitters.indexOf(selectedSplitterData)
    : -1
  const selectedApartments = selectedSplitterData 
    ? apartmentsBySplitterId[selectedSplitterData.id] ?? []
    : []
  const selectedPenetration = selectedSplitterData 
    ? selectedSplitterData.ratio / Math.max(1, selectedApartments.length) * 100
    : 0
  const penetrationBySplitterId = useMemo(
    () => Object.fromEntries(
      activeEntrance.splitters.map(s => {
        const apartmentsCount = apartmentsBySplitterId[s.id]?.length ?? 0
        return [s.id, s.ratio / Math.max(1, apartmentsCount) * 100]
      })
    ) as Record<string, number>,
    [activeEntrance.splitters, apartmentsBySplitterId]
  )
  const medianPenetration = getMedian(Object.values(penetrationBySplitterId))
  const selectedPenetrationVisual = getPenetrationVisual(selectedPenetration, medianPenetration)
  const hoveredSplitterInfo = hoveredApartment !== null
    ? getSplitterForApartment(hoveredApartment)
    : null

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-zinc-100 mb-2">Калькулятор сплиттеров</h1>
        
        {/* Stats */}
        <div className="flex gap-4 text-xs text-zinc-400 mb-4">
          <span>Парадных: {totalStats.entrances}</span>
          <span>Этажей: {totalStats.floors}</span>
          <span>Квартир: {totalStats.apartments}</span>
          <span>Стояков: {totalStats.risers}</span>
          <span>Сплиттеров: {totalStats.splitters}</span>
        </div>
        
        {/* Entrance tabs */}
        <div className="flex gap-2 flex-wrap mb-4">
          {entrances.map(e => (
            <div
              key={e.id}
              className={`group flex items-center rounded transition-colors ${
                e.id === activeEntranceId 
                  ? 'bg-zinc-700 text-white' 
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              <button
                className="pl-3 pr-2 py-1.5 text-sm"
                onClick={() => setActiveEntranceId(e.id)}
              >
                {e.name} ({e.startApartment}-{e.startApartment + e.totalApartments - 1})
              </button>
              {entrances.length > 1 && (
                <button
                  data-testid={`delete-entrance-${e.id}`}
                  className="mr-1 flex h-5 w-5 items-center justify-center rounded text-xs text-zinc-400 hover:bg-zinc-600 hover:text-white"
                  title={`Удалить ${e.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteEntrance(e.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            className="px-3 py-1.5 text-sm rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            onClick={openAddEntrance}
          >
            + Добавить
          </button>
        </div>
      </div>

      <div className="flex gap-4">
        {/* Schema */}
        <div className="flex-1">
          <div className="bg-zinc-900 rounded-lg p-4" ref={schemaRef}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-sm font-medium text-zinc-300">
                {activeEntrance.name}: {activeEntrance.totalApartments} кв, {activeEntrance.floors} эт
              </h2>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600"
                  onClick={openSettings}
                >
                  Настройки
                </button>
                {entrances.length > 1 && (
                  <button
                    className="px-3 py-1 text-xs rounded bg-red-900 hover:bg-red-800"
                    onClick={() => deleteEntrance(activeEntranceId)}
                  >
                    Удалить
                  </button>
                )}
              </div>
            </div>
            
            {/* Floor schema - bottom to top */}
            <div className="flex flex-col-reverse gap-0.5">
              {Array.from({ length: activeEntrance.floors }, (_, i) => i + 1).map(renderFloor)}
            </div>
            
            <div className="mt-4 text-xs text-zinc-500">
              Клик — выбрать сплиттер | Перетяните края для изменения зоны | + для добавления
            </div>
          </div>
        </div>

        {/* Info panel */}
        <div className="w-72">
          {/* Apartment info */}
          {hoveredApartment && (
            <div className="bg-zinc-900 rounded-lg p-4 mb-4">
              <div className="text-xs text-zinc-500 mb-1">Квартира</div>
              <div className="text-2xl font-mono mb-2">{hoveredApartment}</div>
              {hoveredSplitterInfo && (
                <div className="text-xs text-zinc-400">
                  Сплиттер: {getSplitterLabel(hoveredSplitterInfo.splitter)} (1/{hoveredSplitterInfo.splitter.ratio})
                </div>
              )}
            </div>
          )}

          {/* Selected splitter info */}
          {selectedSplitterData && (
            <div className="bg-zinc-900 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-4 h-4 rounded ${getSplitterColor(selectedSplitterIndex)}`} />
                <div className="text-sm font-medium">
                  Сплиттер {getSplitterLabel(selectedSplitterData)}
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                <div className="bg-zinc-800 rounded p-2">
                  <div className="text-zinc-500">Ratio</div>
                  <div className="font-mono">1/{selectedSplitterData.ratio}</div>
                </div>
                <div className="bg-zinc-800 rounded p-2">
                  <div className="text-zinc-500">Этажи</div>
                  <div className="font-mono">{selectedSplitterData.floorsServed[0]}-{selectedSplitterData.floorsServed[1]}</div>
                </div>
                <div className="bg-zinc-800 rounded p-2">
                  <div className="text-zinc-500">Квартир</div>
                  <div className="font-mono">{selectedApartments.length}</div>
                </div>
                <div className={`rounded p-2 ${selectedPenetrationVisual.cardClass} ${selectedPenetrationVisual.outlierClass}`}>
                  <div className="flex items-center justify-between">
                    <div className="text-zinc-200">Проникн.</div>
                    {selectedPenetrationVisual.label && (
                      <div className="text-[10px] uppercase tracking-wide text-red-200">{selectedPenetrationVisual.label}</div>
                    )}
                  </div>
                  <div className={`font-mono ${selectedPenetrationVisual.textClass}`}>{selectedPenetration.toFixed(0)}%</div>
                </div>
              </div>
              
              <div className="text-xs text-zinc-500 mb-1">Квартиры (клик для копирования):</div>
              <div 
                className={`
                  bg-zinc-800 rounded p-2 font-mono text-sm cursor-pointer 
                  hover:bg-zinc-700 transition-colors
                  ${copiedText === formatApartmentRanges(selectedApartments) ? 'ring-2 ring-emerald-500' : ''}
                `}
                onClick={() => copyToClipboard(formatApartmentRanges(selectedApartments))}
              >
                {formatApartmentRanges(selectedApartments)}
              </div>
              {copiedText && <div className="text-xs text-emerald-500 mt-1">Скопировано</div>}
            </div>
          )}

          {/* All splitters table */}
          <div className="bg-zinc-900 rounded-lg p-4">
            <div className="text-sm font-medium text-zinc-300 mb-3">Все сплиттеры</div>
            <div className="space-y-2">
              {activeEntrance.splitters.map((s, i) => {
                const apts = apartmentsBySplitterId[s.id] ?? []
                const pen = penetrationBySplitterId[s.id] ?? (s.ratio / Math.max(1, apts.length) * 100)
                const penVisual = getPenetrationVisual(pen, medianPenetration)
                return (
                  <div 
                    key={s.id}
                    className={`
                      flex items-center gap-2 p-2 rounded cursor-pointer transition-colors
                      ${selectedSplitter === s.id ? 'bg-zinc-700' : 'bg-zinc-800 hover:bg-zinc-700'}
                      ${penVisual.outlierClass}
                    `}
                    onClick={() => {
                      setSelectedSplitter(s.id)
                      setEditingSplitter(s.id)
                    }}
                  >
                    <div className={`w-3 h-3 rounded ${getSplitterColor(i)}`} />
                    <div className="flex-1 text-xs">
                      <span className="font-mono">{getSplitterLabel(s)}</span>
                      <span className="text-zinc-500 ml-2">1/{s.ratio}</span>
                    </div>
                    <div className="text-xs text-zinc-400">{apts.length}кв</div>
                    <div className={`text-xs font-mono ${penVisual.textClass}`}>
                      {pen.toFixed(0)}%
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div 
          className="fixed bg-zinc-800 border border-zinc-700 rounded shadow-xl py-1 z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full px-4 py-1.5 text-left text-sm hover:bg-zinc-700"
            onClick={() => {
              const s = activeEntrance.splitters.find(s => s.id === contextMenu.splitterId)
              if (s) updateSplitter(s.id, { ratio: s.ratio === 4 ? 8 : 4 })
              setContextMenu(null)
            }}
          >
            Сменить ratio
          </button>
          {!isSingleRiser && (
            <button
              className="w-full px-4 py-1.5 text-left text-sm hover:bg-zinc-700"
              onClick={() => {
                const s = activeEntrance.splitters.find(s => s.id === contextMenu.splitterId)
                if (s) updateSplitterResolved(s.id, { side: s.side === 'left' ? 'right' : 'left' })
                setContextMenu(null)
              }}
            >
              Перенести на другой стояк
            </button>
          )}
          <button
            className="w-full px-4 py-1.5 text-left text-sm hover:bg-zinc-700"
            onClick={() => {
              const s = activeEntrance.splitters.find(s => s.id === contextMenu.splitterId)
              if (s) copyToClipboard(formatApartmentRanges(apartmentsBySplitterId[s.id] ?? []))
              setContextMenu(null)
            }}
          >
            Копировать квартиры
          </button>
          <button
            className="w-full px-4 py-1.5 text-left text-sm text-red-400 hover:bg-zinc-700"
            onClick={() => {
              deleteSplitter(contextMenu.splitterId)
            }}
          >
            Удалить
          </button>
        </div>
      )}

      {/* Add entrance modal */}
      {showAddEntrance && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setShowAddEntrance(false)}>
          <div className="bg-zinc-900 rounded-lg p-6 max-w-3xl w-full max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-lg font-medium">Новая парадная</h2>
              <button className="text-zinc-400 hover:text-white text-xl" onClick={() => setShowAddEntrance(false)}>×</button>
            </div>

            <div className="grid grid-cols-5 gap-4 mb-5">
              <label className="col-span-2">
                <span className="block text-xs text-zinc-500 mb-1">Название</span>
                <input
                  value={entranceDraft.name}
                  onChange={(e) => setEntranceDraft({ ...entranceDraft, name: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Этажей</span>
                <NumberInput
                  min={1}
                  value={entranceDraft.floors}
                  onValueChange={(floors) => {
                    setEntranceDraft({ ...entranceDraft, floors })
                    setFloorGroups(createDefaultGroups(floors, entranceDraft.apartmentsPerFloor, entranceDraft.leftRiser, entranceDraft.totalApartments, entranceDraft.riserCount))
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Всего квартир</span>
                <NumberInput
                  min={1}
                  value={entranceDraft.totalApartments}
                  onValueChange={(totalApartments) => {
                    setEntranceDraft({ ...entranceDraft, totalApartments })
                    setFloorGroups(createDefaultGroups(entranceDraft.floors, entranceDraft.apartmentsPerFloor, entranceDraft.leftRiser, totalApartments, entranceDraft.riserCount))
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Стояков</span>
                <select
                  value={entranceDraft.riserCount}
                  onChange={(e) => {
                    const riserCount = parseInt(e.target.value) as RiserCount
                    setEntranceDraft({ ...entranceDraft, riserCount })
                    setFloorGroups(createDefaultGroups(entranceDraft.floors, entranceDraft.apartmentsPerFloor, entranceDraft.leftRiser, entranceDraft.totalApartments, riserCount))
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-5">
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Целевое проникновение, %</span>
                <NumberInput
                  min={0}
                  integer={false}
                  value={entranceDraft.targetPenetration}
                  onValueChange={(targetPenetration) => setEntranceDraft({ ...entranceDraft, targetPenetration })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <div className="col-span-2">
                <span className="block text-xs text-zinc-500 mb-2">Допустимые типы</span>
                <div className="flex gap-4">
                  {[8, 4].map(ratio => (
                    <label key={ratio} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={entranceDraft.allowedRatios.includes(ratio as SplitterRatio)}
                        onChange={() => toggleAllowedRatio(ratio as SplitterRatio, true)}
                      />
                      1/{ratio}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="mb-5">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-sm font-medium text-zinc-300">Группы этажей</h3>
                <button className="px-3 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600" onClick={() => addFloorGroup(entranceDraft.riserCount)}>
                  + Добавить группу
                </button>
              </div>
              <div className="space-y-2">
                {floorGroups.map(group => (
                  <div key={group.id} className="grid grid-cols-6 gap-2 bg-zinc-800 rounded p-3 items-end">
                    <label>
                      <span className="block text-[10px] text-zinc-500 mb-1">С этажа</span>
                      <NumberInput min={1} max={entranceDraft.floors} value={group.from} onValueChange={(value) => updateFloorGroup(group.id, { from: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                    </label>
                    <label>
                      <span className="block text-[10px] text-zinc-500 mb-1">По этаж</span>
                      <NumberInput min={group.from} max={entranceDraft.floors} value={group.to} onValueChange={(value) => updateFloorGroup(group.id, { to: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                    </label>
                    <label>
                      <span className="block text-[10px] text-zinc-500 mb-1">Квартир</span>
                      <NumberInput min={0} value={group.total} onValueChange={(value) => updateFloorGroup(group.id, { total: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                    </label>
                    {entranceDraft.riserCount === 2 && (
                      <label>
                        <span className="block text-[10px] text-zinc-500 mb-1">Левый стояк</span>
                        <NumberInput min={0} max={group.total} value={group.left} onValueChange={(value) => updateFloorGroup(group.id, { left: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                      </label>
                    )}
                    <div className={entranceDraft.riserCount === 2 ? 'col-span-1' : 'col-span-2'} />
                    <button className="text-red-400 hover:text-red-300 text-sm justify-self-end" onClick={() => removeFloorGroup(group.id)}>Удалить</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button className="px-4 py-2 text-sm rounded bg-zinc-700 hover:bg-zinc-600" onClick={() => setShowAddEntrance(false)}>Отмена</button>
              <button className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500" onClick={addEntrance}>Создать</button>
            </div>
          </div>
        </div>
      )}

      {/* Settings modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setShowSettings(false)}>
          <div className="bg-zinc-900 rounded-lg p-6 max-w-4xl w-full max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-lg font-medium">Настройки парадной</h2>
              <button className="text-zinc-400 hover:text-white text-xl" onClick={() => setShowSettings(false)}>×</button>
            </div>

            <div className="grid grid-cols-5 gap-4 mb-6">
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Название</span>
                <input
                  value={activeEntrance.name}
                  onChange={(e) => updateEntrance({ name: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Этажей</span>
                <NumberInput
                  min={1}
                  value={activeEntrance.floors}
                  onValueChange={(floors) => {
                    const groups = createDefaultGroups(floors, activeEntrance.apartmentsPerFloor, activeEntrance.leftRiser, activeEntrance.totalApartments, activeEntrance.riserCount)
                    const configs = groupsToFloorConfigs(floors, activeEntrance.riserCount, groups)
                    setFloorGroups(groups)
                    updateEntrance({
                      floors,
                      floorConfigs: configs,
                      totalApartments: configs.reduce((sum, config) => sum + config.total, 0),
                      // иначе при уменьшении этажности остаются сплиттеры,
                      // обслуживающие несуществующие этажи
                      splitters: clampSplittersToFloors(activeEntrance.splitters, floors),
                    })
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Всего квартир</span>
                <NumberInput
                  min={1}
                  value={activeEntrance.totalApartments}
                  onValueChange={(total) => {
                    const groups = createDefaultGroups(activeEntrance.floors, activeEntrance.apartmentsPerFloor, activeEntrance.leftRiser, total, activeEntrance.riserCount)
                    const configs = groupsToFloorConfigs(activeEntrance.floors, activeEntrance.riserCount, groups)
                    setFloorGroups(groups)
                    updateEntrance({ totalApartments: total, floorConfigs: configs })
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Кв на этаже</span>
                <NumberInput
                  min={1}
                  value={activeEntrance.apartmentsPerFloor}
                  onValueChange={(perFloor) => {
                    const groups = createDefaultGroups(activeEntrance.floors, perFloor, activeEntrance.leftRiser, activeEntrance.totalApartments, activeEntrance.riserCount)
                    const configs = groupsToFloorConfigs(activeEntrance.floors, activeEntrance.riserCount, groups)
                    setFloorGroups(groups)
                    updateEntrance({ apartmentsPerFloor: perFloor, floorConfigs: configs, totalApartments: configs.reduce((sum, config) => sum + config.total, 0) })
                  }}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Стояков</span>
                <select value={activeEntrance.riserCount} onChange={(e) => updateActiveRiserCount(parseInt(e.target.value) as RiserCount)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm">
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <label>
                <span className="block text-xs text-zinc-500 mb-1">Целевое проникновение, %</span>
                <NumberInput
                  min={0}
                  integer={false}
                  value={activeEntrance.targetPenetration}
                  onValueChange={(targetPenetration) => updateEntrance({ targetPenetration })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
                />
              </label>
              <div>
                <span className="block text-xs text-zinc-500 mb-2">Допустимые типы</span>
                <div className="flex gap-4">
                  {[8, 4].map(ratio => (
                    <label key={ratio} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={activeEntrance.allowedRatios.includes(ratio as SplitterRatio)}
                        onChange={() => toggleAllowedRatio(ratio as SplitterRatio)}
                      />
                      1/{ratio}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex items-end">
                <button className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-500" onClick={applyAutoLayout}>
                  Пересчитать
                </button>
              </div>
            </div>

            {autoLayoutMessage && (
              <div className="mb-6 rounded border border-zinc-700 bg-zinc-800 p-3 text-sm">
                <div>{autoLayoutMessage}</div>
                {autoLayoutFallbacks && !autoLayoutFallbacks.strict && (
                  <div className="mt-3 flex gap-2">
                    {autoLayoutFallbacks.nearestAbove && (
                      <button className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600" onClick={() => applyFallbackLayout('nearestAbove')}>
                        Применить ближайший
                      </button>
                    )}
                    {autoLayoutFallbacks.expandedTypes && (
                      <button className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600" onClick={() => applyFallbackLayout('expandedTypes')}>
                        Расширить типы
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="mb-6">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-sm font-medium text-zinc-300">Группы этажей</h3>
                <div className="flex gap-2">
                  <button className="px-3 py-1 text-xs rounded bg-zinc-700 hover:bg-zinc-600" onClick={() => addFloorGroup(activeEntrance.riserCount)}>+ Добавить группу</button>
                  <button className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500" onClick={applyActiveFloorGroups}>Применить группы</button>
                </div>
              </div>
              <div className="space-y-2">
                {floorGroups.map(group => (
                  <div key={group.id} className="grid grid-cols-6 gap-2 bg-zinc-800 rounded p-3 items-end">
                    <label>
                      <span className="block text-[10px] text-zinc-500 mb-1">С этажа</span>
                      <NumberInput min={1} max={activeEntrance.floors} value={group.from} onValueChange={(value) => updateFloorGroup(group.id, { from: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                    </label>
                    <label>
                      <span className="block text-[10px] text-zinc-500 mb-1">По этаж</span>
                      <NumberInput min={group.from} max={activeEntrance.floors} value={group.to} onValueChange={(value) => updateFloorGroup(group.id, { to: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                    </label>
                    <label>
                      <span className="block text-[10px] text-zinc-500 mb-1">Квартир</span>
                      <NumberInput min={0} value={group.total} onValueChange={(value) => updateFloorGroup(group.id, { total: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                    </label>
                    {!isSingleRiser && (
                      <label>
                        <span className="block text-[10px] text-zinc-500 mb-1">Левый стояк</span>
                        <NumberInput min={0} max={group.total} value={group.left} onValueChange={(value) => updateFloorGroup(group.id, { left: value })} className="w-full bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs" />
                      </label>
                    )}
                    <div className={!isSingleRiser ? 'col-span-1' : 'col-span-2'} />
                    <button className="text-red-400 hover:text-red-300 text-sm justify-self-end" onClick={() => removeFloorGroup(group.id)}>Удалить</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <h3 className="text-sm font-medium text-zinc-300 mb-3">Точечная правка этажей</h3>
              <div className="grid grid-cols-6 gap-2 max-h-64 overflow-auto">
                {activeEntrance.floorConfigs.map((config, i) => (
                  <div key={i} className="bg-zinc-800 rounded p-2">
                    <div className="text-xs text-zinc-500 mb-1">Этаж {i + 1}</div>
                    <div className="flex gap-1">
                      <NumberInput
                        min={0}
                        value={config.total}
                        onValueChange={(total) => {
                          const newConfigs = [...activeEntrance.floorConfigs]
                          newConfigs[i] = { total, left: isSingleRiser ? total : Math.min(newConfigs[i].left, total) }
                          updateEntrance({ floorConfigs: newConfigs, totalApartments: newConfigs.reduce((sum, c) => sum + c.total, 0) })
                          setFloorGroups(floorConfigsToGroups(newConfigs, activeEntrance.riserCount))
                        }}
                        className="w-12 bg-zinc-700 border border-zinc-600 rounded px-1 py-0.5 text-xs"
                        title="Всего"
                      />
                      {!isSingleRiser && (
                        <NumberInput
                          min={0}
                          max={config.total}
                          value={config.left}
                          onValueChange={(value) => {
                            const newConfigs = [...activeEntrance.floorConfigs]
                            newConfigs[i] = { ...newConfigs[i], left: value }
                            updateEntrance({ floorConfigs: newConfigs })
                            setFloorGroups(floorConfigsToGroups(newConfigs, activeEntrance.riserCount))
                          }}
                          className="w-12 bg-zinc-700 border border-zinc-600 rounded px-1 py-0.5 text-xs"
                          title="Левый"
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
