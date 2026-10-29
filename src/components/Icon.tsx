interface Props {
  glyph: string;
  color: string;
  size?: number;
}

// Minimal inline-SVG icon set — no external icon dependency.
export function Icon({ glyph, color, size = 20 }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (glyph) {
    case "folder":
      return (
        <svg {...common} fill={color} stroke="none">
          <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
        </svg>
      );
    case "image":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9" r="1.5" fill={color} />
          <path d="M21 16l-5-5L5 20" />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 9l5 3-5 3V9z" fill={color} stroke="none" />
        </svg>
      );
    case "audio":
      return (
        <svg {...common}>
          <path d="M9 18V5l10-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="16" cy="16" r="3" />
        </svg>
      );
    case "archive":
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M12 3v4M10 7h4M12 7v3M10 10h4M12 10v3" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12" />
        </svg>
      );
    case "exe":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9l3 3-3 3M13 15h3" />
        </svg>
      );
    case "file":
    default:
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </svg>
      );
  }
}

// UI chrome icons (toolbar, sidebar) rendered by name.
export function UIIcon({ name, size = 18 }: { name: string; size?: number }) {
  const c = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "back":
      return <svg {...c}><path d="M15 18l-6-6 6-6" /></svg>;
    case "forward":
      return <svg {...c}><path d="M9 18l6-6-6-6" /></svg>;
    case "up":
      return <svg {...c}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
    case "refresh":
      return <svg {...c}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>;
    case "search":
      return <svg {...c}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
    case "grid":
      return <svg {...c}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>;
    case "list":
      return <svg {...c}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>;
    case "new-folder":
      return <svg {...c}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" /><path d="M12 11v4M10 13h4" /></svg>;
    case "drive":
      return <svg {...c}><rect x="2" y="7" width="20" height="10" rx="2" /><circle cx="17" cy="12" r="1" fill="currentColor" /></svg>;
    case "home":
      return <svg {...c}><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>;
    case "x":
      return <svg {...c}><path d="M18 6L6 18M6 6l12 12" /></svg>;
    case "desktop":
      return <svg {...c}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
    case "documents":
      return <svg {...c}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>;
    case "downloads":
      return <svg {...c}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>;
    case "pictures":
      return <svg {...c}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5L5 20" /></svg>;
    case "music":
      return <svg {...c}><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></svg>;
    case "videos":
      return <svg {...c}><rect x="3" y="5" width="14" height="14" rx="2" /><path d="M17 10l4-2v8l-4-2" /></svg>;
    case "cloud":
      return <svg {...c}><path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 10.1 4 4 0 0 0 7 18z" /></svg>;
    case "pin":
      return <svg {...c}><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" /></svg>;
    case "settings":
      return <svg {...c}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
    case "down":
      return <svg {...c}><path d="M12 5v14M5 12l7 7 7-7" /></svg>;
    case "cut":
      return <svg {...c}><circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" /><path d="M8.1 16.1L18 4M15.9 16.1L6 4" /></svg>;
    case "copy":
      return <svg {...c}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>;
    case "paste":
      return <svg {...c}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 11h6M9 15h4" /></svg>;
    case "rename":
      return <svg {...c}><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" /></svg>;
    case "trash":
      return <svg {...c}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;
    case "open":
      return <svg {...c}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7l-4 9V7z" /><path d="M3 19l3-8h16l-3 8H3z" /></svg>;
    case "open-with":
      return <svg {...c}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M17.5 14v7M14 17.5h7" /></svg>;
    case "new-tab":
      return <svg {...c}><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 9h18M12 12v5M9.5 14.5h5" /></svg>;
    case "eye":
      return <svg {...c}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
    case "zip":
      return <svg {...c}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M11 6h1M11 9h1M11 12h1M10.5 15h2v3h-2z" /></svg>;
    case "extract":
      return <svg {...c}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M12 10v6M9.5 13.5L12 16l2.5-2.5" /></svg>;
    case "copy-path":
      return <svg {...c}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 15l3-6M11 15l3-6" /></svg>;
    case "terminal":
      return <svg {...c}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>;
    case "properties":
      return <svg {...c}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></svg>;
    case "more":
      return <svg {...c}><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></svg>;
    case "explorer":
      return <svg {...c}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M14 13h5M16.5 10.5L19 13l-2.5 2.5" /></svg>;
    case "new-file":
      return <svg {...c}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14h6" /></svg>;
    case "select-all":
      return <svg {...c}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 12l3 3 5-6" /></svg>;
    case "plus":
      return <svg {...c}><path d="M12 5v14M5 12h14" /></svg>;
    case "folder":
      return <svg {...c}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" /></svg>;
    case "split":
      return <svg {...c}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>;
    case "unsplit":
      return <svg {...c}><rect x="3" y="4" width="18" height="16" rx="2" /></svg>;
    case "storage":
      return <svg {...c}><path d="M21 12a9 9 0 1 1-9-9v9z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" /></svg>;
    case "other-pane":
      return <svg {...c}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16M7 12h2M15 12h2" /></svg>;
    default:
      return null;
  }
}
