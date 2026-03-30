"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface EditableFieldProps {
  value: string;
  onSave: (value: string) => void;
  className?: string;
  tag?: "span" | "p" | "h4";
  multiline?: boolean;
  placeholder?: string;
}

export default function EditableField({
  value,
  onSave,
  className = "",
  tag = "span",
  multiline = false,
  placeholder = "Click to edit...",
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    if (draft.trim() !== value) {
      onSave(draft.trim());
    }
  }, [draft, value, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !multiline) {
        e.preventDefault();
        commit();
      }
      if (e.key === "Escape") {
        setDraft(value);
        setEditing(false);
      }
    },
    [commit, multiline, value]
  );

  if (editing) {
    const sharedClass = `bg-background border border-accent/40 rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 ${className}`;

    if (multiline) {
      return (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className={`${sharedClass} w-full min-h-[60px] resize-y`}
          placeholder={placeholder}
        />
      );
    }

    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={`${sharedClass} w-full`}
        placeholder={placeholder}
      />
    );
  }

  const Tag = tag;
  const displayValue = value || placeholder;
  const isEmpty = !value;

  return (
    <Tag
      onClick={() => setEditing(true)}
      className={`cursor-pointer hover:bg-accent/5 hover:outline hover:outline-1 hover:outline-accent/20 rounded px-0.5 -mx-0.5 transition-all ${isEmpty ? "text-muted/40 italic" : ""} ${className}`}
      title="Click to edit"
    >
      {displayValue}
    </Tag>
  );
}
