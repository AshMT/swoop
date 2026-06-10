interface MagpieProps {
  size?: number;
  className?: string;
  sticker?: boolean;
}

export default function Magpie({ size = 40, className = '', sticker = true }: MagpieProps) {
  return (
    <img
      src="/magpie.png"
      width={size}
      height={size}
      className={className}
      style={sticker ? { filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.28))' } : undefined}
      alt="Swoop magpie"
      draggable={false}
    />
  );
}
