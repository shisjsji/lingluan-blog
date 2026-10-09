import { useCallback, useEffect, useMemo, useRef } from 'react'
import { gsap } from 'gsap'
import { InertiaPlugin } from 'gsap/InertiaPlugin'
import './DotGrid.css'

// React Bits DotGrid adapted from the official JS/CSS example:
// https://reactbits.dev/backgrounds/dot-grid
gsap.registerPlugin(InertiaPlugin)

const throttle = (fn, limit) => {
  let lastCall = 0
  return (...args) => {
    const now = performance.now()
    if (now - lastCall >= limit) {
      lastCall = now
      fn(...args)
    }
  }
}

function hexToRgb(hex) {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
  if (!match) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  }
}

export default function DotGrid({
  dotSize = 5,
  gap = 36,
  baseColor = '#c8c9c1',
  activeColor = '#e67851',
  proximity = 145,
  speedTrigger = 100,
  shockRadius = 230,
  shockStrength = 4,
  maxSpeed = 5000,
  resistance = 750,
  returnDuration = 1.4,
  className = '',
}) {
  const wrapperRef = useRef(null)
  const canvasRef = useRef(null)
  const dotsRef = useRef([])
  const pointerRef = useRef({ x: 0, y: 0, lastTime: 0, lastX: 0, lastY: 0 })

  const baseRgb = useMemo(() => hexToRgb(baseColor), [baseColor])
  const activeRgb = useMemo(() => hexToRgb(activeColor), [activeColor])
  const circlePath = useMemo(() => {
    if (typeof window === 'undefined' || !window.Path2D) return null
    const path = new window.Path2D()
    path.arc(0, 0, dotSize / 2, 0, Math.PI * 2)
    return path
  }, [dotSize])

  const buildGrid = useCallback(() => {
    const wrapper = wrapperRef.current
    const canvas = canvasRef.current
    if (!wrapper || !canvas) return
    const { width, height } = wrapper.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const context = canvas.getContext('2d')
    if (context) context.scale(dpr, dpr)

    const cell = dotSize + gap
    const columns = Math.floor((width + gap) / cell)
    const rows = Math.floor((height + gap) / cell)
    const startX = (width - (cell * columns - gap)) / 2 + dotSize / 2
    const startY = (height - (cell * rows - gap)) / 2 + dotSize / 2
    const dots = []
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        dots.push({
          cx: startX + x * cell,
          cy: startY + y * cell,
          xOffset: 0,
          yOffset: 0,
          _inertiaApplied: false,
        })
      }
    }
    dotsRef.current = dots
  }, [dotSize, gap])

  useEffect(() => {
    if (!circlePath) return undefined
    let frame
    const proximitySquared = proximity * proximity
    const draw = () => {
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (!canvas || !context) return
      context.clearRect(0, 0, canvas.width, canvas.height)
      const { x: pointerX, y: pointerY } = pointerRef.current
      for (const dot of dotsRef.current) {
        const distanceX = dot.cx - pointerX
        const distanceY = dot.cy - pointerY
        const distanceSquared = distanceX * distanceX + distanceY * distanceY
        let color = baseColor
        if (distanceSquared <= proximitySquared) {
          const ratio = 1 - Math.sqrt(distanceSquared) / proximity
          color = `rgb(${Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * ratio)}, ${Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * ratio)}, ${Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * ratio)})`
        }
        context.save()
        context.translate(dot.cx + dot.xOffset, dot.cy + dot.yOffset)
        context.fillStyle = color
        context.fill(circlePath)
        context.restore()
      }
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [activeRgb, baseColor, baseRgb, circlePath, proximity])

  useEffect(() => {
    buildGrid()
    let resizeObserver
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(buildGrid)
      if (wrapperRef.current) resizeObserver.observe(wrapperRef.current)
    } else {
      window.addEventListener('resize', buildGrid)
    }
    return () => {
      resizeObserver?.disconnect()
      if (!resizeObserver) window.removeEventListener('resize', buildGrid)
    }
  }, [buildGrid])

  useEffect(() => {
    const move = (event) => {
      const now = performance.now()
      const pointer = pointerRef.current
      const deltaTime = pointer.lastTime ? now - pointer.lastTime : 16
      const deltaX = event.clientX - pointer.lastX
      const deltaY = event.clientY - pointer.lastY
      let velocityX = (deltaX / deltaTime) * 1000
      let velocityY = (deltaY / deltaTime) * 1000
      let speed = Math.hypot(velocityX, velocityY)
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed
        velocityX *= scale
        velocityY *= scale
        speed = maxSpeed
      }
      pointer.lastTime = now
      pointer.lastX = event.clientX
      pointer.lastY = event.clientY
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      pointer.x = event.clientX - rect.left
      pointer.y = event.clientY - rect.top
      for (const dot of dotsRef.current) {
        const distance = Math.hypot(dot.cx - pointer.x, dot.cy - pointer.y)
        if (speed > speedTrigger && distance < proximity && !dot._inertiaApplied) {
          dot._inertiaApplied = true
          gsap.killTweensOf(dot)
          gsap.to(dot, {
            inertia: { xOffset: dot.cx - pointer.x + velocityX * 0.005, yOffset: dot.cy - pointer.y + velocityY * 0.005, resistance },
            onComplete: () => {
              gsap.to(dot, { xOffset: 0, yOffset: 0, duration: returnDuration, ease: 'elastic.out(1,0.75)', onComplete: () => { dot._inertiaApplied = false } })
            },
          })
        }
      }
    }
    const click = (event) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      for (const dot of dotsRef.current) {
        const distance = Math.hypot(dot.cx - x, dot.cy - y)
        if (distance < shockRadius && !dot._inertiaApplied) {
          dot._inertiaApplied = true
          gsap.killTweensOf(dot)
          const falloff = Math.max(0, 1 - distance / shockRadius)
          gsap.to(dot, {
            inertia: { xOffset: (dot.cx - x) * shockStrength * falloff, yOffset: (dot.cy - y) * shockStrength * falloff, resistance },
            onComplete: () => {
              gsap.to(dot, { xOffset: 0, yOffset: 0, duration: returnDuration, ease: 'elastic.out(1,0.75)', onComplete: () => { dot._inertiaApplied = false } })
            },
          })
        }
      }
    }
    const throttledMove = throttle(move, 50)
    window.addEventListener('mousemove', throttledMove, { passive: true })
    window.addEventListener('click', click)
    return () => {
      window.removeEventListener('mousemove', throttledMove)
      window.removeEventListener('click', click)
    }
  }, [maxSpeed, proximity, resistance, returnDuration, shockRadius, shockStrength, speedTrigger])

  return <div ref={wrapperRef} className={`dot-grid ${className}`} aria-hidden="true"><canvas ref={canvasRef} className="dot-grid__canvas" /></div>
}
