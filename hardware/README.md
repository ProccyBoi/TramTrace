# TramTrace hardware map

This map was traced from both source files, not from reference-number order:

- `D:\Electronics Projects\TramTrace\TramTrace.kicad_sch`
- `D:\Electronics Projects\TramTrace\TramTrace.kicad_pcb`
- `D:\Electronics Projects\TramTrace\Print Schematic.pdf`

The schematic establishes the MCU pins, level shifter, and WS2812 serial nets.
The PCB establishes which physical light sits beside each printed station.
`STATION_MAPPING.csv` is the resulting code-ready cross-reference.

## Electrical chains

| Purpose | ESP32 GPIO | Level-shifted net | Pixels | First LED |
|---|---:|---|---:|---|
| Status | 25 | `Status - HS` | 1 | LED1 |
| L1 | 16 | `L1 - HS` | 45 | LED94 |
| L2 branch | 17 | `L2 - HS` | 8 | LED39 |
| L3 and L2/L3 shared trunk | 18 | `L3 - HS` | 30 | LED36 |
| L4 | 19 | `L4 - HS` | 32 | LED2 |

U3 is an ESP32-WROOM-32E. U5 is an MC14504BDR2G translating the four route
signals and status signal from 3.3 V to 5 V. Every route light is a
WS2812C-2020-V1/W with pad 3 as DI and pad 1 as DO.

The exact data-chain orders are:

```text
L1: LED94 LED98 LED102 LED106 LED110 LED114 LED118 LED122 LED123 LED119
    LED115 LED111 LED107 LED103 LED99 LED95 LED71 LED96 LED100 LED104
    LED108 LED112 LED116 LED120 LED121 LED117 LED113 LED109 LED105 LED101
    LED97 LED75 LED126 LED130 LED134 LED138 LED142 LED146 LED150 LED154
    LED155 LED151 LED147 LED143 LED139

L2: LED39 LED68 LED72 LED76 LED80 LED84 LED88 LED92

L3: LED36 LED40 LED44 LED48 LED52 LED56 LED60 LED64 LED65 LED61 LED57
    LED53 LED49 LED45 LED41 LED37 LED34 LED38 LED42 LED46 LED50 LED54
    LED58 LED62 LED63 LED59 LED55 LED51 LED47 LED43

L4: LED2 LED3 LED4 LED5 LED6 LED7 LED8 LED9 LED10 LED11 LED12 LED13
    LED14 LED15 LED16 LED17 LED18 LED20 LED22 LED24 LED26 LED28 LED30
    LED32 LED33 LED31 LED29 LED27 LED25 LED23 LED21 LED19
```

## Direction convention

The firmware and current TfNSW schedule index use this payload convention:

| Route | First light / payload slot 0 | Second light / payload slot 1 |
|---|---|---|
| L1 | toward Dulwich Hill | toward Central |
| L2 | toward Randwick | toward Circular Quay |
| L3 | toward Juniors Kingsford | toward Circular Quay |
| L4 | toward Westmead | toward Carlingford |

The schematic and PCB prove the station pairing, LED references, and serial
chain order, but they do not contain destination arrows that can prove which
adjacent LED is inbound or outbound. The slot-to-destination labels are
therefore a software/GTFS convention until they are visually confirmed on the
assembled front board. Use the `test-pairs` serial command: it prints each
station, lights slot 0, then lights slot 1.

## Layout exceptions

- L1 Central has one dedicated pixel, LED139, rather than a pair. Firmware
  merges both L1 direction states into it. The schematic explicitly notes
  "One LED at central".
- Central also has the separate L2/L3 pair LED41/LED37, so Central has three
  physical route lights in total.
- L2's GPIO17 chain only covers Randwick through Royal Randwick. From Moore
  Park through Circular Quay, L2 reuses the corresponding L3-chain pixels.
- The board and current feed say `Bank Street`. Older feeds call the same
  stable parent stop `200952` "Fish Market".

## Power

There are 116 addressable LEDs including status. Do not run an all-white,
full-brightness test from a normal computer USB port. The firmware caps remote
brightness at 64/255 and its hardware test lights only one route pixel at a
time.
