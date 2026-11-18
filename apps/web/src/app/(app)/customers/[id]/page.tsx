"use client";

import { use } from "react";
import { PartyDetail } from "@/components/party-pages";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PartyDetail kind="customer" id={id} />;
}
