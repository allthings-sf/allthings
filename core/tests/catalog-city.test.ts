import { expect, test } from "bun:test";
import { cityPattern } from "../src/catalog.ts";
import { cityAddresses } from "./support/city-addresses.ts";

test.each(cityAddresses)("extracts the city from %p as %p", (address, city) => {
  expect(cityPattern.exec(address)?.[1]?.trim() || null).toBe(city);
});
