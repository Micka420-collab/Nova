// Small stroke icons for the renderer (lucide-react is a dependency of @nova/ui only, not of the app).
// Always decorative: the control carrying an icon has its own accessible name.
import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

interface IconProps {
  size?: number;
}

export const PlusIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ArrowUpIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </Icon>
);
export const StopIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);
export const CheckIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);
export const CopyIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 5H7a2 2 0 0 0-2 2v8" />
  </Icon>
);
export const SearchIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);
export const SettingsIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 7h9M18 7h2M4 17h3M12 17h8" />
    <circle cx="15.5" cy="7" r="2.5" />
    <circle cx="9.5" cy="17" r="2.5" />
  </Icon>
);
export const PencilIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />
  </Icon>
);
export const TrashIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Icon>
);
export const MenuIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);
export const PanelRightIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
);
export const RefreshIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
  </Icon>
);
export const EyeIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const EyeOffIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    <path d="m3 3 18 18" />
  </Icon>
);
export const HomeIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m4 11 8-7 8 7M6 9.5V20h12V9.5" />
  </Icon>
);
export const ExternalIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);
export const ChevronDownIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const CloseIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
