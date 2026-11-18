(() => {
  HezuoBots.mount()

  const approve = document.querySelector('.approve')
  if (approve) {
    const autoByLevel = { ask: [false, false, false], edits: [true, false, false], full: [true, true, true] }
    const card = approve.querySelector('.ask-card')
    const done = card.querySelector('.ask-done')
    const asker = card.querySelector('.bot')
    const settle = (text, declined = false) => {
      done.textContent = text
      done.classList.toggle('off', declined)
      card.dataset.state = 'done'
      HezuoBots.set(asker, declined ? 'idle' : 'done')
    }
    const apply = (level) => {
      approve.dataset.level = level
      for (const button of approve.querySelectorAll('.seg button')) {
        button.setAttribute('aria-checked', String(button.dataset.level === level))
      }
      for (const badge of approve.querySelectorAll('[data-perm]')) {
        const auto = autoByLevel[level][Number(badge.dataset.perm)]
        badge.textContent = auto ? '自动' : '先问'
        badge.classList.toggle('auto', auto)
      }
      if (level === 'full') settle('已自动发送')
      else {
        delete card.dataset.state
        HezuoBots.set(asker, 'asking')
      }
    }
    approve.querySelector('.seg').addEventListener('click', (event) => {
      const button = event.target.closest('button')
      if (button) apply(button.dataset.level)
    })
    card.querySelector('.allow').addEventListener('click', () => settle('已发送'))
    card.querySelector('.deny').addEventListener('click', () => settle('已取消', true))
  }

  const roster = document.querySelector('.roster')
  const picker = document.querySelector('.picker')
  if (roster && picker) {
    let card = roster.querySelector('[aria-pressed="true"]')
    const sync = () => {
      const { kind, color } = card.querySelector('.bot').dataset
      for (const each of roster.children) each.setAttribute('aria-pressed', String(each === card))
      for (const button of picker.querySelectorAll('button[data-kind]')) {
        button.setAttribute('aria-pressed', String(button.dataset.kind === kind))
        const sample = button.querySelector('.bot')
        if (sample.dataset.color !== color) HezuoBots.swap(sample, { color })
      }
      for (const button of picker.querySelectorAll('button[data-color]')) {
        button.setAttribute('aria-pressed', String(button.dataset.color === color))
      }
    }
    roster.addEventListener('click', (event) => {
      const picked = event.target.closest('.bot-card')
      if (!picked) return
      card = picked
      sync()
    })
    picker.addEventListener('click', (event) => {
      const button = event.target.closest('button')
      if (!button) return
      HezuoBots.swap(card.querySelector('.bot'), button.dataset.kind ? { kind: button.dataset.kind } : { color: button.dataset.color })
      sync()
    })
    sync()
  }

  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''
  const os = /win/i.test(platform) ? 'windows' : /linux|x11/i.test(platform) ? 'linux' : 'mac'
  for (const button of document.querySelectorAll('[data-os]')) {
    const mine = button.dataset.os === os
    button.classList.toggle('primary', mine)
    button.classList.toggle('ghost', !mine)
  }

  const bar = document.querySelector('header')
  const menu = bar.querySelector('.menu')
  const setMenu = (open) => {
    bar.classList.toggle('open', open)
    menu.setAttribute('aria-expanded', String(open))
  }
  menu.addEventListener('click', () => setMenu(!bar.classList.contains('open')))
  bar.querySelector('nav ul').addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenu(false)
  })

  if (!document.documentElement.classList.contains('motion')) return

  let waiting = [...document.querySelectorAll('[data-scene]')]
  const header = document.querySelector('header')
  const hero = document.querySelector('.hero .window')
  const onScroll = () => {
    header.classList.toggle('scrolled', window.scrollY > 8)
    const line = window.innerHeight * 0.85
    waiting = waiting.filter((scene) => {
      if (scene.getBoundingClientRect().top > line) return true
      scene.classList.add('play')
      return false
    })
    if (hero) {
      const progress = (window.innerHeight - hero.getBoundingClientRect().top) / (window.innerHeight * 0.6)
      hero.style.setProperty('--p', Math.max(0, Math.min(1, progress)).toFixed(3))
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  onScroll()
})()
