export const cityAddresses = [
  [
    "CodeRabbit, 201 Spear St 12th floor, San Francisco, CA 94105, USA",
    "San Francisco",
  ],
  ["1 Market St, San Francisco, CA 94105", "San Francisco"],
  ["500 Coffee Ave, Oakland, CA", "Oakland"],
  [
    "Pier 70, 420 22nd St, San Francisco, CA 94107-1234, United States",
    "San Francisco",
  ],
  ["201 Spear St, Suite 1100, San Francisco, CA 94105", "San Francisco"],
  // A street just before the state is never taken for the city.
  ["201 Spear St, CA 94105, USA", null],
  ["Spear St, CA 94105, USA", null],
  ["Sentry, Spear St, CA 94105", null],
  ["Studio 54, Spear St, CA 94105, USA", null],
  ["Studio 54, San Francisco, CA 94105", null],
  ["201 Spear St, MARKET AVE., CA 94105", null],
  ["201 Spear St, ste. #4, Oakland, CA", "Oakland"],
  ["201 Spear St, #4, Oakland, CA", "Oakland"],
  // Nor is a city alone, which can't be told from a street alone.
  ["San Francisco, CA, USA", null],
  ["Golden Gate Park", null],
  ["", null],
] as const;
