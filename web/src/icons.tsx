type IconProps = {
  size?: number;
};

export function SearchIcon({ size = 20 }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </svg>
  );
}

export function CloseIcon({ size = 22 }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size}>
      <path d="m5 5 14 14M19 5 5 19" />
    </svg>
  );
}

export function ExternalIcon({ size = 18 }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
    </svg>
  );
}

export function ResetIcon({ size = 20 }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

export function SettingsIcon({ size = 22 }: IconProps) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 2.5v2.25M12 19.25v2.25M2.5 12h2.25M19.25 12h2.25M5.28 5.28l1.59 1.59M17.13 17.13l1.59 1.59M18.72 5.28l-1.59 1.59M6.87 17.13l-1.59 1.59" />
    </svg>
  );
}
