import type { HostIconName } from '@nekro-nxt/contracts'
import {
  AppWindow,
  BarChart3,
  BookOpen,
  Boxes,
  Database,
  FileText,
  Folder,
  Globe,
  LayoutDashboard,
  Puzzle,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

/** The fixed icon vocabulary extensions may name for panels and pages. */
export const HOST_ICONS: Readonly<Record<HostIconName, LucideIcon>> = {
  'app-window': AppWindow,
  'bar-chart': BarChart3,
  'book-open': BookOpen,
  boxes: Boxes,
  database: Database,
  'file-text': FileText,
  folder: Folder,
  globe: Globe,
  'layout-dashboard': LayoutDashboard,
  puzzle: Puzzle,
  terminal: Terminal,
  workflow: Workflow,
  wrench: Wrench,
}
