"use client";
import { createContext, useCallback, useContext } from "react";
import { ukrainian } from "./i18n/uk";
import { translateRuntime } from "./i18n/runtime";

export type Language = "en" | "uk";
export type Vars = Record<string, string | number>;
export const LanguageContext = createContext<Language>("en");

/** English is the source language. Ukrainian comes from the dictionary; missing entries fall back to English. */
export function translate(language: Language, text: string, vars?: Vars) {
  const template = language === "uk" ? ukrainian[text] ?? text : text;
  return vars ? template.replace(/\{(\w+)\}/g, (match, key: string) => key in vars ? String(vars[key]) : match) : template;
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export function useTranslation() {
  const language = useContext(LanguageContext);
  return useCallback((text: string, vars?: Vars) => translate(language, text, vars), [language]);
}

/**
 * Messages produced by the science code, workers and API are Ukrainian at the source.
 * They are translated only here, at display time; the producers stay untouched.
 */
export function useMessage() {
  const language = useContext(LanguageContext);
  return useCallback((message: string | null | undefined) => message ? translateRuntime(language, message) : "", [language]);
}
