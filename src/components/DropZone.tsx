import { useRef, useState } from "react";

interface Props {
  onFiles: (files: File[]) => void;
  label: string;
  hint?: string;
  compact?: boolean;
}

export function DropZone({ onFiles, label, hint, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`dropzone ${compact ? "dropzone-compact" : ""} ${dragOver ? "dropzone-active" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,.xls,.py"
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <strong>{label}</strong>
      {hint && <span className="dropzone-hint">{hint}</span>}
    </div>
  );
}
