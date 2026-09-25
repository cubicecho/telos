import ActivitySource from 'lucide-react-native/icons/activity';
import ArchiveSource from 'lucide-react-native/icons/archive';
import ArchiveRestoreSource from 'lucide-react-native/icons/archive-restore';
import Columns3Source from 'lucide-react-native/icons/columns-3';
import EllipsisSource from 'lucide-react-native/icons/ellipsis';
import Link2Source from 'lucide-react-native/icons/link-2';
import ListSource from 'lucide-react-native/icons/list';
import LogOutSource from 'lucide-react-native/icons/log-out';
import MessageSquareSource from 'lucide-react-native/icons/message-square';
import TagSource from 'lucide-react-native/icons/tag';
import { icon } from '@/components/ui/icons';

/**
 * Icons this app draws that cubeui's `icons` item does not ship, wrapped with
 * that item's own `icon()` so they size and colour like the rest.
 */
export const Activity = icon(ActivitySource);
export const Archive = icon(ArchiveSource);
export const ArchiveRestore = icon(ArchiveRestoreSource);
export const Columns3 = icon(Columns3Source);
export const Ellipsis = icon(EllipsisSource);
export const Link2 = icon(Link2Source);
export const List = icon(ListSource);
export const LogOut = icon(LogOutSource);
export const MessageSquare = icon(MessageSquareSource);
export const Tag = icon(TagSource);
