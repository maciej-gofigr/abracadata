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
        multiple
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {!compact && (
        <svg className="dz-cloud" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 18a4 4 0 01-.5-7.97A5.5 5.5 0 0117.9 9.5 3.75 3.75 0 0117 18H7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M12 15V9m0 0l-2.2 2.2M12 9l2.2 2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <strong>{label}</strong>
      {hint && <span className="dropzone-hint">{hint}</span>}
    </div>
  );
}
