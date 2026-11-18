"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type Me = {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; role: string } | null;
  role: string | null;
  permissions: string[];
  organizations: { id: string; name: string; role: string }[];
};

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), retry: false, staleTime: 60_000 });
}

export function useCan(permission: string) {
  const me = useMe();
  return me.data?.permissions.includes(permission) ?? false;
}
