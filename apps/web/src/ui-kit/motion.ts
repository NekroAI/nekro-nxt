import type { Transition, Variants } from 'motion/react'

export const nxtDuration = {
  instant: 0.08,
  fast: 0.12,
  standard: 0.18,
  spatial: 0.28,
  emphasis: 0.34,
} as const

export const nxtEase = {
  standard: [0.2, 0.7, 0.2, 1],
  enter: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
} as const

type EaseTuple = readonly [number, number, number, number]

export const tween = (duration: number, ease: EaseTuple): Transition => ({
  type: 'tween',
  duration,
  ease: [...ease],
})

const enter = (duration: number): Transition => tween(duration, nxtEase.enter)
const exit = (duration: number): Transition => tween(duration, nxtEase.exit)
const standard = (duration: number): Transition => tween(duration, nxtEase.standard)

export const overlayVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, transition: exit(nxtDuration.fast) },
}

export const dialogVariants: Variants = {
  hidden: { opacity: 0, scale: 0.985 },
  visible: { opacity: 1, scale: 1, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, scale: 0.985, transition: exit(nxtDuration.fast) },
}

export const tooltipVariants: Variants = {
  hidden: { opacity: 0, y: 3 },
  visible: { opacity: 1, y: 0, transition: enter(nxtDuration.fast) },
  exit: { opacity: 0, y: 3, transition: exit(nxtDuration.instant) },
}

export const popoverVariants: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  visible: { opacity: 1, scale: 1, transition: enter(0.16) },
  exit: { opacity: 0, scale: 0.98, transition: exit(0.1) },
}

export const toastVariants: Variants = {
  hidden: { opacity: 0, y: -8 },
  visible: { opacity: 1, y: 0, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, y: -8, transition: exit(nxtDuration.standard) },
}

export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, transition: exit(nxtDuration.fast) },
}

export const objectVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, y: 8, transition: exit(nxtDuration.fast) },
}

export const routeVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: enter(nxtDuration.spatial) },
  exit: { opacity: 0, y: -8, transition: exit(nxtDuration.standard) },
}

export const inspectorVariants: Variants = {
  hidden: { opacity: 0, x: 12 },
  visible: { opacity: 1, x: 0, transition: standard(nxtDuration.spatial) },
  exit: { opacity: 0, x: 12, transition: exit(nxtDuration.standard) },
}

export const floatVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, y: 8, transition: exit(nxtDuration.fast) },
}

export const themeIconVariants: Variants = {
  hidden: { opacity: 0, rotate: -35, scale: 0.72 },
  visible: { opacity: 1, rotate: 0, scale: 1, transition: enter(nxtDuration.standard) },
  exit: { opacity: 0, scale: 0.72, transition: exit(nxtDuration.fast) },
}

export const enterKinds = {
  fade: fadeVariants,
  object: objectVariants,
  route: routeVariants,
  toast: toastVariants,
  overlay: overlayVariants,
  dialog: dialogVariants,
  tooltip: tooltipVariants,
  popover: popoverVariants,
  inspector: inspectorVariants,
  float: floatVariants,
  themeIcon: themeIconVariants,
} as const

export type EnterKind = keyof typeof enterKinds

export const disclosureTransition: Transition = standard(nxtDuration.spatial)
