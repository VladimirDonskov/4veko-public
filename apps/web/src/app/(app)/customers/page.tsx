"use client";

import { Suspense } from "react";
import { PartyList } from "@/components/party-pages";

export default function Page() {
  return (
    <Suspense>
      <PartyList kind="customer" />
    </Suspense>
  );
}
