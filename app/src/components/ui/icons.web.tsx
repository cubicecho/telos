/**
 * The icon set, web implementation — see `icons.tsx` for the native one and why
 * this module exists at all.
 *
 * Web needs no wrapper: an `<svg>` already takes `className`, and its colour
 * comes from `currentColor` on the container, hover states included. Pinning a
 * colour here — the way the native file has to — would break exactly that. So
 * this is a plain re-export (and an `icon` that wraps nothing), and the barrel is fine because the web bundler does
 * tree-shake.
 *
 * The exported names must stay in step with `icons.tsx`. TypeScript will not
 * check it, because it only ever resolves the native file; `scripts/check-registry-build.mjs`
 * does.
 */
import type { LucideIcon, LucideProps } from 'lucide-react';

/** What an icon takes — the name `icons.tsx` exports for its wrapped icons. */
export type IconProps = LucideProps;

/**
 * The web half of `icons.tsx`'s `icon`: there is nothing to wrap, so it hands
 * the glyph back. It exists so an app's extra glyph is the same line on both
 * platforms — `export const Archive = icon(ArchiveSource)` — in an `app-icons.tsx` that
 * imports the source from `lucide-react-native/icons/archive` and an
 * `app-icons.web.tsx` beside it that imports it from `lucide-react`.
 */
export function icon(Source: LucideIcon): LucideIcon {
  return Source;
}

export {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  Clock,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  FilePen,
  FileText,
  Folder,
  FolderPen,
  Info,
  KeyRound,
  Library,
  LoaderCircle,
  Lock,
  Monitor,
  Moon,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
