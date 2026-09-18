// Garrett - The Keeper Lore & Quotes
// "To keep what is unseen; to take what must be preserved."

(function (root, factory) {
  const exportsObj = factory();
  if (typeof globalThis !== 'undefined') {
    globalThis.GarrettKeeper = exportsObj;
  }
  if (typeof root !== 'undefined') {
    root.GarrettKeeper = exportsObj;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = exportsObj;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const KEEPER_QUOTES = [
    {
      quote: "What is merely watched is soon forgotten. What is taken is kept.",
      source: "Keeper Annuary, Ch. VII"
    },
    {
      quote: "The City streams its treasures like water through fingers. We step from the shadows so nothing is lost.",
      source: "Keeper Caduca"
    },
    {
      quote: "It is not theft when the void would have claimed it anyway. To take before it vanishes is true preservation.",
      source: "First Keeper"
    },
    {
      quote: "The Keepers taught me to see what others overlook. They called it Balance. I call it keeping what's mine.",
      source: "Garrett"
    },
    {
      quote: "A stream flows only until the gate is shut. A prize kept in shadow endures for all time.",
      source: "Keeper Annals"
    },
    {
      quote: "To walk unseen, to listen unheard, and to take what was never meant to last.",
      source: "Book of the Closed Circle"
    },
    {
      quote: "They thought their walls were impenetrable and their streams untouchable. They forgot about me.",
      source: "Garrett"
    },
    {
      quote: "They called it a stream, as though it could never be held. But even the swiftest river yields its gold to patient hands.",
      source: "Keeper Terces"
    },
    {
      quote: "True balance demands that which is shown to the light must also be secured in the archives.",
      source: "Keeper Glyph Inscription"
    },
    {
      quote: "I have no interest in their prophecies. But knowing how to take what others let fade? That was worth learning.",
      source: "Garrett"
    },
    {
      quote: "Better to hold it in the dark than watch it vanish in the morning light.",
      source: "Garrett"
    },
    {
      quote: "The keepers write of unseen forces. I only care about the prize in hand.",
      source: "Garrett"
    }
  ];

  function getRandomKeeperQuote() {
    const index = Math.floor(Math.random() * KEEPER_QUOTES.length);
    return KEEPER_QUOTES[index];
  }

  return {
    KEEPER_QUOTES,
    getRandomKeeperQuote
  };
});
