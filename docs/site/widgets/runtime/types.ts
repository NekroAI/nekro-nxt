// What the bundle carries for each widget (scripts/docs-bundle.mjs resolves spec.mjs data into these).

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ThemedImage {
  readonly light: string
  readonly dark: string
  readonly width: number
  readonly height: number
}

export interface TourData {
  readonly shot: ThemedImage
  /** Boxes are fractions of the shot, so they hold at any display size. */
  readonly steps: readonly { readonly text: string; readonly box: Box }[]
}

export interface DiagramNode {
  readonly id: string
  readonly label: string
  readonly note?: string
  readonly at?: readonly [number, number]
}

export type DiagramData =
  | {
      readonly type: 'flow'
      readonly nodes: readonly DiagramNode[]
      readonly edges: readonly { readonly from: string; readonly to: string; readonly label?: string }[]
      readonly animate: boolean
    }
  | {
      readonly type: 'layers'
      readonly layers: readonly { readonly label: string; readonly note?: string; readonly items: readonly string[] }[]
    }
  | {
      readonly type: 'compare'
      readonly columns: readonly {
        readonly title: string
        readonly tone: 'positive' | 'neutral' | 'negative'
        readonly points: readonly string[]
      }[]
    }

export type Widget =
  | { readonly id: string; readonly kind: 'tour'; readonly title: string; readonly data: TourData }
  | { readonly id: string; readonly kind: 'diagram'; readonly title: string; readonly data: DiagramData }

/**
 * How a widget is shown. Live is the interactive version; a poster freezes one state (`overview`, `step-2`) at one
 * moment of its animation, without controls, for still images and GIF frames.
 */
export type Mode = { readonly kind: 'live' } | { readonly kind: 'poster'; readonly state: string; readonly time: number }
