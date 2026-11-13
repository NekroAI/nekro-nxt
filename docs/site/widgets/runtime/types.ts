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

export type WizardStep =
  | {
      readonly id: string
      readonly ask: string
      readonly choices: readonly { readonly label: string; readonly next: string }[]
    }
  | { readonly id: string; readonly answer: string; readonly link?: string }

export interface WizardData {
  /** The first step is where it starts. */
  readonly steps: readonly WizardStep[]
}

export interface ChatData {
  readonly agent: string
  readonly modes: readonly { readonly id: string; readonly label: string; readonly note?: string }[]
  /** Her reply to each message by mode id; without modes, under ''. A mode missing means she stays quiet. */
  readonly messages: readonly {
    readonly from: string
    readonly text: string
    readonly replies: Readonly<Record<string, string>>
  }[]
}

export interface PipelineData {
  readonly stages: readonly { readonly label: string; readonly note?: string; readonly detail: string }[]
}

export type Widget =
  | { readonly id: string; readonly kind: 'tour'; readonly title: string; readonly data: TourData }
  | { readonly id: string; readonly kind: 'diagram'; readonly title: string; readonly data: DiagramData }
  | { readonly id: string; readonly kind: 'wizard'; readonly title: string; readonly data: WizardData }
  | { readonly id: string; readonly kind: 'chat'; readonly title: string; readonly data: ChatData }
  | { readonly id: string; readonly kind: 'pipeline'; readonly title: string; readonly data: PipelineData }

/**
 * How a widget is shown. Live is the interactive version; a poster freezes one state (`overview`, `step-2`) at one
 * moment of its animation, without controls, for still images and GIF frames.
 */
export type Mode = { readonly kind: 'live' } | { readonly kind: 'poster'; readonly state: string; readonly time: number }
