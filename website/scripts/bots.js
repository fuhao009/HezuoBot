globalThis.HezuoBots = (() => {
  const TAU = Math.PI * 2
  const UP = -Math.PI / 2
  const SAMPLES = 120
  const INK = '#0d1b26'
  const palette = {
    cyan: ['#b9fff3', '#3fdcf2', '#1290cc'],
    blue: ['#c3daff', '#5b95ff', '#2a5ce0'],
    green: ['#c8f8da', '#3fd086', '#0e9160'],
    orange: ['#ffe5bd', '#ffa246', '#e36f18'],
    purple: ['#e5daff', '#a383f7', '#6f45d8'],
    pink: ['#ffdaec', '#f67cba', '#cc3a88'],
  }
  const stateNames = ['idle', 'working', 'thinking', 'asking', 'done', 'error']

  const mod = (x, m) => ((x % m) + m) % m
  const lobe = (x, k) => Math.sign(x) * Math.pow(Math.abs(x), k)
  const polygon = (n, rot, sharp) => (t) => {
    const half = Math.PI / n
    return 1 + (Math.cos(half) / Math.cos(mod(t - rot, 2 * half) - half) - 1) * sharp
  }
  const ellipse = (a, b, tilt) => (t) => (a * b) / Math.hypot(b * Math.cos(t - tilt), a * Math.sin(t - tilt))
  const petals = (n, rot, depth, k) => (t) => 1 - depth + depth * Math.pow(Math.abs(Math.cos((n * (t - rot)) / 2)), k)
  const spikes = (n, rot, depth, k) => (t) => 1 + depth * lobe(Math.cos(n * (t - rot)), k)
  const bump = (t, at, width) => Math.exp(-Math.pow(Math.atan2(Math.sin(t - at), Math.cos(t - at)) / width, 2))

  const archetypes = {
    circle: ['圆', () => ({ radius: () => 1, soften: 0 })],
    pill: ['胶囊', (rand) => ({ radius: ellipse(1.32, 0.76, rand(-0.5, 0.5)), soften: 0 })],
    egg: ['蛋', () => ({ radius: (t) => ellipse(0.86, 1.08, 0)(t) * (1 + 0.1 * Math.sin(t)), soften: 0 })],
    triangle: ['三角', (rand) => ({ radius: polygon(3, UP + rand(-0.25, 0.25), 0.9), soften: 10 })],
    square: ['方', (rand) => ({ radius: polygon(4, Math.PI / 4 + rand(-0.12, 0.12), 0.78), soften: 8 })],
    pentagon: ['五边', (rand) => ({ radius: polygon(5, UP + rand(-0.3, 0.3), 0.95), soften: 6 })],
    hexagon: ['六边', (rand) => ({ radius: polygon(6, rand(0, 1), 1), soften: 5 })],
    star4: ['四角星', (rand) => ({ radius: spikes(4, rand(-0.3, 0.3), 0.27, 1.7), soften: 3 })],
    star5: ['五角星', (rand) => ({ radius: spikes(5, UP + rand(-0.2, 0.2), 0.22, 1.5), soften: 3 })],
    clover: ['四叶', (rand) => ({ radius: petals(4, rand(-0.3, 0.3), 0.3, 0.6), soften: 4 })],
    flower: ['花', (rand, pick) => ({ radius: petals(pick([5, 6]), UP, 0.26, 0.7), soften: 3 })],
    cloud: [
      '云',
      (rand, pick) => {
        const wide = ellipse(1.15, 0.9, 0)
        const scallops = petals(pick([7, 8, 9]), rand(0, 1), 0.16, 0.8)
        return { radius: (t) => wide(t) * scallops(t), soften: 2 }
      },
    ],
    drop: [
      '水滴',
      (rand) => {
        const tip = UP + rand(-0.5, 0.5)
        return { radius: (t) => 1 + 0.6 * bump(t, tip, 0.4), soften: 3 }
      },
    ],
    bean: [
      '豆',
      (rand) => {
        const tilt = rand(-0.6, 0.6)
        const body = ellipse(1.25, 0.85, tilt)
        return { radius: (t) => body(t) - 0.24 * bump(t, tilt + UP, 0.5), soften: 3 }
      },
    ],
    dome: ['馒头', () => ({ radius: (t) => (Math.sin(t) < 0 ? ellipse(1, 1.05, 0)(t) : ellipse(1, 0.45, 0)(t)), soften: 7 })],
    splat: [
      '泼溅',
      (rand, pick) => {
        const n = pick([6, 7, 8])
        const rot = rand(0, 1)
        const heights = Array.from({ length: n }, () => rand(0.14, 0.34))
        return {
          radius: (t) => {
            const phase = (n * (t - rot)) / 2
            return 0.82 + heights[Math.floor(mod(phase + Math.PI / 2, n * Math.PI) / Math.PI) % n] * Math.pow(Math.abs(Math.cos(phase)), 1.1)
          },
          soften: 2,
        }
      },
    ],
    pebble: [
      '卵石',
      (rand) => {
        const p = rand(0, TAU)
        const q = rand(0, TAU)
        return { radius: (t) => 1 + 0.13 * Math.cos(2 * t + p) + 0.1 * Math.cos(3 * t + q), soften: 0 }
      },
    ],
  }

  const seeded = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const hash = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) | 0, 7)
  const cache = new Map()
  const shapeOf = (kind, seed) => {
    const key = `${kind}:${seed}`
    if (cache.has(key)) return cache.get(key)
    const next = seeded(hash(kind) + seed * 7919)
    const rand = (lo, hi) => lo + next() * (hi - lo)
    const pick = (list) => list[Math.floor(next() * list.length)]
    const { radius, soften } = archetypes[kind][1](rand, pick)
    let radii = Array.from({ length: SAMPLES }, (_, i) => radius((i / SAMPLES) * TAU))
    for (let pass = 0; pass < soften; pass++) radii = radii.map((r, i) => (radii[(i + SAMPLES - 1) % SAMPLES] + 2 * r + radii[(i + 1) % SAMPLES]) / 4)
    const raw = radii.map((r, i) => [r * Math.cos((i / SAMPLES) * TAU), r * Math.sin((i / SAMPLES) * TAU)])
    const xs = raw.map((point) => point[0])
    const ys = raw.map((point) => point[1])
    const width = Math.max(...xs) - Math.min(...xs)
    const height = Math.max(...ys) - Math.min(...ys)
    const scale = 68 / Math.max(width, height)
    const placed = raw.map(([x, y]) => [50 + (x - (Math.max(...xs) + Math.min(...xs)) / 2) * scale, 49 + (y - (Math.max(...ys) + Math.min(...ys)) / 2) * scale])
    let area = 0
    let cx = 0
    let cy = 0
    placed.forEach(([x, y], i) => {
      const [nx, ny] = placed[(i + 1) % SAMPLES]
      const cross = x * ny - nx * y
      area += cross
      cx += (x + nx) * cross
      cy += (y + ny) * cross
    })
    cx /= 3 * area
    cy /= 3 * area
    const polar = placed.map(([x, y]) => [Math.atan2(y - cy, x - cx), Math.hypot(x - cx, y - cy)])
    const shape = { center: [cx, cy], polar, mean: polar.reduce((sum, point) => sum + point[1], 0) / SAMPLES, ground: 49 + (height * scale) / 2, width: width * scale }
    cache.set(key, shape)
    return shape
  }

  const outline = (shape, m) => {
    const [cx, cy] = shape.center
    const path = shape.polar.map(([angle, radius], i) => {
      const r = (shape.mean + (radius - shape.mean) * m.amp) * (1 + m.ripple * 0.045 * Math.sin((3 * i * TAU) / SAMPLES - m.spin * 4))
      return [cx + r * Math.cos(angle) * m.sx, shape.ground + (cy + r * Math.sin(angle) - shape.ground) * m.sy]
    })
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const start = mid(path[SAMPLES - 1], path[0])
    let d = `M${start[0].toFixed(1)} ${start[1].toFixed(1)}`
    for (let i = 0; i < SAMPLES; i++) {
      const next = mid(path[i], path[(i + 1) % SAMPLES])
      d += `Q${path[i][0].toFixed(1)} ${path[i][1].toFixed(1)} ${next[0].toFixed(1)} ${next[1].toFixed(1)}`
    }
    return d + 'Z'
  }

  const neutral = { amp: 1, ripple: 0, sx: 1, sy: 1, tx: 0, ty: 0, rot: 0, ex: 0, ey: 0, es: 1, squint: 1, red: 0, work: 0, spin: 0, happy: 0, hurt: 0, blink: 1 }
  const pose = {
    idle: () => ({}),
    working: (t, tau, o) => {
      const s = Math.sin(t * 5 + o)
      return { work: 1, ripple: 1, sy: 1 + 0.05 * s, sx: 1 - 0.04 * s, ex: 4 * Math.sin(t * 2.6 + o), ey: 1.6, squint: 0.82 }
    },
    thinking: (t, tau, o) => {
      const breath = 1 + 0.03 * Math.sin(t * 1.5 + o)
      return { work: 0.35, ripple: 0.5, sx: breath, sy: breath, amp: 1 + 0.1 * Math.sin(t * 1.1 + o), ex: 3.5 + 1.2 * Math.sin(t * 0.8 + o), ey: -3 }
    },
    asking: (t, tau, o) => {
      const hop = Math.abs(Math.sin(t * 2.2 + o))
      return { ty: -4 * hop, sy: 1 + 0.04 * hop, sx: 1 - 0.03 * hop, rot: 6 * Math.sin(t * 2.2 + o), es: 1.18 }
    },
    done: (t, tau) => {
      const fade = Math.exp(-tau * 2.4)
      const wobble = fade * Math.sin(tau * 16 + 1.2)
      return { happy: 1, ty: -10 * fade * Math.abs(Math.sin(tau * 8)), sy: 1 + 0.1 * wobble, sx: 1 - 0.08 * wobble }
    },
    error: (t, tau) => ({ hurt: 1, red: 1, sy: 0.9, sx: 1.07, amp: 0.6, rot: -3, ey: 1.5, tx: tau % 2 < 0.5 ? 1.6 * Math.sin(tau * 40) : 0 }),
  }
  const blinks = { working: true, thinking: true, asking: true }
  const blend = (weights, t, tau, offset) => {
    const m = { ...neutral }
    for (const name of stateNames) {
      const weight = weights[name]
      if (weight < 0.002) continue
      const delta = pose[name](t, tau, offset)
      for (const key in delta) m[key] += (delta[key] - neutral[key]) * weight
    }
    return m
  }
  const settled = (state) => blend(Object.fromEntries(stateNames.map((name) => [name, name === state ? 1 : 0])), 0, 30, 0)

  const attributes = (shape, m) => {
    const ground = shape.ground
    const faceX = shape.center[0].toFixed(2)
    const faceY = (ground + (shape.center[1] + 2 - ground) * m.sy).toFixed(2)
    const lift = 1 + m.ty / 40
    return {
      outline: outline(shape, m),
      alarm: (m.red * 0.9).toFixed(2),
      shadow: `translate(${(50 + m.tx).toFixed(2)} 0) scale(${lift.toFixed(3)} 1) translate(-50 0)`,
      shadowOpacity: lift.toFixed(2),
      body: `translate(${m.tx.toFixed(2)} ${m.ty.toFixed(2)}) rotate(${m.rot.toFixed(2)} ${faceX} ${ground.toFixed(1)})`,
      face: `translate(${faceX} ${faceY})`,
      open: `translate(${m.ex.toFixed(2)} ${m.ey.toFixed(2)}) scale(${m.es.toFixed(3)} ${(m.es * m.squint * m.blink).toFixed(3)})`,
      openOpacity: (1 - Math.max(m.happy, m.hurt)).toFixed(2),
      happy: m.happy.toFixed(2),
      hurt: m.hurt.toFixed(2),
    }
  }

  let serial = 0
  const inner = (shape, color, state, prefix) => {
    const [light, base, dark] = palette[color]
    const id = `${prefix}${serial++}`
    const a = attributes(shape, settled(state))
    const cover = 'x="-30" y="-30" width="160" height="160"'
    const sweep = 'gradientUnits="userSpaceOnUse" x1="78" y1="12" x2="24" y2="88"'
    return `<defs><clipPath id="${id}c"><path data-part="outline" d="${a.outline}"/></clipPath><linearGradient id="${id}g" ${sweep}><stop offset="0" stop-color="${light}"/><stop offset=".45" stop-color="${base}"/><stop offset="1" stop-color="${dark}"/></linearGradient><linearGradient id="${id}r" ${sweep}><stop offset="0" stop-color="#ffd0c6"/><stop offset=".45" stop-color="#ff8177"/><stop offset="1" stop-color="#dc4352"/></linearGradient><radialGradient id="${id}h" gradientUnits="userSpaceOnUse" cx="38" cy="28" r="44"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><radialGradient id="${id}s" gradientUnits="userSpaceOnUse" cx="48" cy="40" r="54"><stop offset=".6" stop-color="${INK}" stop-opacity="0"/><stop offset="1" stop-color="${INK}" stop-opacity=".42"/></radialGradient><radialGradient id="${id}k"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><radialGradient id="${id}f"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs><ellipse data-part="shadow" cx="50" cy="${(shape.ground + 6).toFixed(1)}" rx="${(shape.width * 0.36).toFixed(1)}" ry="4.5" fill="url(#${id}f)" transform="${a.shadow}" opacity="${a.shadowOpacity}"/><g data-part="body" transform="${a.body}"><g clip-path="url(#${id}c)"><rect ${cover} fill="url(#${id}g)"/><rect data-part="alarm" ${cover} fill="url(#${id}r)" opacity="${a.alarm}"/><rect ${cover} fill="url(#${id}s)"/><rect ${cover} fill="url(#${id}h)"/><ellipse cx="37" cy="27" rx="11" ry="6.5" fill="url(#${id}k)" transform="rotate(-28 37 27)"/></g><g data-part="face" transform="${a.face}"><g data-part="open" fill="${INK}" transform="${a.open}" opacity="${a.openOpacity}"><ellipse cx="-10.5" rx="4.7" ry="6.9"/><ellipse cx="10.5" rx="4.7" ry="6.9"/><circle cx="-12" cy="-2.9" r="1.8" fill="#fff"/><circle cx="9" cy="-2.9" r="1.8" fill="#fff"/></g><path data-part="happy" d="M-15.5 2.5q5-8.5 10 0M5.5 2.5q5-8.5 10 0" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" opacity="${a.happy}"/><path data-part="hurt" d="M-14.5-4.5l7 4.5-7 4.5M14.5-4.5l-7 4.5 7 4.5" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="${a.hurt}"/></g></g>`
  }
  const markup = ({ kind, color, state = 'idle', seed = 1 }) =>
    `<svg class="bot" viewBox="0 0 100 100" data-kind="${kind}" data-color="${color}" data-state="${state}" data-seed="${seed}" aria-hidden="true">${inner(shapeOf(kind, seed), color, state, 'b')}</svg>`

  const items = new Map()
  const adopt = (svg, index) => {
    const part = (name) => svg.querySelector(`[data-part="${name}"]`)
    const state = svg.dataset.state
    items.set(svg, {
      shape: shapeOf(svg.dataset.kind, Number(svg.dataset.seed)),
      nodes: Object.fromEntries(['outline', 'alarm', 'shadow', 'body', 'face', 'open', 'happy', 'hurt'].map((name) => [name, part(name)])),
      weights: Object.fromEntries(stateNames.map((name) => [name, name === state ? 1 : 0])),
      state,
      since: 0,
      spin: 0,
      offset: (index ?? items.size) * 1.7,
      visible: true,
      resting: false,
    })
  }
  const swap = (svg, change) => {
    Object.assign(svg.dataset, change)
    svg.innerHTML = inner(shapeOf(svg.dataset.kind, Number(svg.dataset.seed)), svg.dataset.color, svg.dataset.state, 'r')
    if (items.has(svg)) adopt(svg, items.get(svg).offset / 1.7)
  }
  let animated = false
  const set = (svg, state) => {
    if (animated) svg.dataset.state = state
    else swap(svg, { state })
  }

  const paint = (item, t, now, dt) => {
    const ease = 1 - Math.exp(-dt * 9)
    let moving = false
    for (const name of stateNames) {
      const goal = name === item.state ? 1 : 0
      const next = item.weights[name] + (goal - item.weights[name]) * ease
      item.weights[name] = Math.abs(goal - next) < 0.002 ? goal : next
      if (item.weights[name] !== goal) moving = true
    }
    const tau = (now - item.since) / 1000
    item.resting = !moving && (item.state === 'idle' || (item.state === 'done' && tau > 3))
    const m = blend(item.weights, t, tau, item.offset)
    item.spin += dt * m.work
    m.spin = item.spin
    m.blink = blinks[item.state] && (t * 0.33 + item.offset * 0.137) % 1 < 0.035 ? 0.1 : 1
    const a = attributes(item.shape, m)
    const n = item.nodes
    n.outline.setAttribute('d', a.outline)
    n.alarm.setAttribute('opacity', a.alarm)
    n.shadow.setAttribute('transform', a.shadow)
    n.shadow.setAttribute('opacity', a.shadowOpacity)
    n.body.setAttribute('transform', a.body)
    n.face.setAttribute('transform', a.face)
    n.open.setAttribute('transform', a.open)
    n.open.setAttribute('opacity', a.openOpacity)
    n.happy.setAttribute('opacity', a.happy)
    n.hurt.setAttribute('opacity', a.hurt)
  }
  const mount = () => {
    document.querySelectorAll('svg.bot').forEach((svg, index) => adopt(svg, index))
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) return
    animated = true
    let last = performance.now()
    let frame = 0
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const sweep = frame++ % 20 === 0
      for (const [svg, item] of items) {
        if (sweep) {
          const box = svg.getBoundingClientRect()
          item.visible = box.bottom > -80 && box.top < window.innerHeight + 80
        }
        const state = svg.dataset.state
        if (state !== item.state) {
          item.state = state
          item.since = now
          item.resting = false
        }
        if (item.visible && !item.resting) paint(item, now / 1000, now, dt)
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  return {
    kinds: Object.entries(archetypes).map(([kind, [label]]) => [kind, label]),
    colors: Object.keys(palette),
    swatch: (color) => `linear-gradient(210deg,${palette[color][0]},${palette[color][1]} 45%,${palette[color][2]})`,
    markup,
    mount,
    swap,
    set,
  }
})()
