# Allegro – kraj sprzedawcy

Dodatek do Firefoksa, który pokazuje na liście wyników Allegro, z jakiego kraju jest sprzedawca, i pozwala jednym kliknięciem ukryć oferty sprzedawców spoza Unii Europejskiej.

Allegro nie pokazuje kraju sprzedawcy na liście ofert – trzeba wejść w ofertę i rozwinąć „Dane sprzedawcy”. Filtr „wysyłka z Polski” nie pomaga, bo wielu sprzedawców spoza UE wysyła z magazynów w Polsce.

## Co robi

- Przy każdej ofercie na liście wyników wyświetla flagę i kod kraju sprzedawcy:
  - zielony – sprzedawca z UE,
  - czerwony (plus czerwona ramka oferty) – sprzedawca spoza UE,
  - szary ❔ – brak danych firmy (zwykle osoba prywatna).
- Panel w prawym dolnym rogu: liczba ofert z UE i spoza UE oraz przełącznik **„Ukryj oferty spoza UE”** (ustawienie jest zapamiętywane).
- Na stronie oferty nad tytułem pojawia się pasek z krajem sprzedawcy.

## Jak to działa

Kraj sprzedawcy jest dostępny tylko na stronie oferty (dane firmy, pole `countryCode`). Dodatek pobiera w tle stronę oferty – tak samo, jak gdybyś ją otworzył – i zapamiętuje kraj sprzedawcy lokalnie na 30 dni. Kolejne oferty tego samego sprzedawcy nie wymagają już pobierania.

Żeby nie przeciążać Allegro, pobiera najwyżej 2 strony naraz z przerwą; jeśli Allegro zacznie odrzucać zapytania, dodatek czeka minutę.

## Prywatność

Dodatek nie zbiera ani nie wysyła żadnych danych. Łączy się wyłącznie z `allegro.pl`, a zapamiętane kraje sprzedawców i ustawienia trzyma w lokalnej pamięci przeglądarki.

## Instalacja do testów

1. Otwórz `about:debugging#/runtime/this-firefox`.
2. Kliknij „Załaduj tymczasowy dodatek…” i wskaż plik `manifest.json`.

## Budowanie paczki

```sh
./build.sh
```

Tworzy `dist/allegro-kraj-sprzedawcy-<wersja>.zip`, gotowy do wysłania na addons.mozilla.org.

## Licencja

Domena publiczna ([The Unlicense](https://unlicense.org)) – bierz i rób z tym, co chcesz.
