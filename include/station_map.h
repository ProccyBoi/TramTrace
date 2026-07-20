#pragma once

#include <cstddef>
#include <cstdint>

namespace tramtrace {

enum class Strip : uint8_t {
  L1 = 0,
  L2 = 1,
  L3 = 2,
  L4 = 3,
  Count = 4,
};

struct PixelPair {
  Strip strip;
  uint8_t direction0;
  uint8_t direction1;
};

struct StationBinding {
  const char *route;
  const char *station;
  PixelPair pixels;
};

constexpr uint8_t kStripPins[] = {16, 17, 18, 19};
constexpr uint16_t kStripLengths[] = {45, 8, 30, 32};
constexpr uint8_t kStatusPin = 25;
constexpr uint8_t kMaximumStripLength = 45;

// Official TfNSW sRGB colours from the current static GTFS routes.txt. These
// values are suitable for a browser, but sRGB channel bytes are nonlinear and
// must not be sent directly to a linear-PWM LED.
constexpr uint32_t kRouteSrgbColours[] = {
    0xBE1622,  // L1
    0xDD1E25,  // L2
    0x781140,  // L3
    0xBB2043,  // L4
};

// Quantisation-aware WS2812C-2020-V1 drive values for the assembled board.
// The four official browser colours are all closely related reds, and their
// small secondary channels disappeared at the board's normal brightness.
// This physical palette deliberately separates them as warm red, bright red,
// dark red and rose-red. L3 remains blue-free because blue made it look pink
// through the assembled LED optics.
constexpr uint32_t kRouteLedColours[] = {
    0xBE2000,  // L1: warm red
    0xFF0000,  // L2: bright clean red
    0x780000,  // L3: dark clean red
    0xBB1030,  // L4: rose-red
};

// The array elements returned by the TramTrace API are canonicalised to the
// current TfNSW GTFS direction slots:
//   [0] L1 Dulwich Hill, L2 Randwick, L3 Juniors Kingsford, L4 Westmead
//   [1] L1 Central,      L2 Circular Quay, L3 Circular Quay, L4 Carlingford
//
// L2's shared trunk intentionally points at L3 physical pixels. L1 Central
// intentionally maps both directions to its one dedicated physical LED.
constexpr StationBinding kStationBindings[] = {
    // L1: Dulwich Hill -> Central, GPIO16.
    {"L1", "Dulwich Hill", {Strip::L1, 0, 1}},
    {"L1", "Dulwich Grove", {Strip::L1, 2, 3}},
    {"L1", "Arlington", {Strip::L1, 4, 5}},
    {"L1", "Waratah Mills", {Strip::L1, 6, 7}},
    {"L1", "Lewisham West", {Strip::L1, 8, 9}},
    {"L1", "Taverners Hill", {Strip::L1, 10, 11}},
    {"L1", "Marion", {Strip::L1, 12, 13}},
    {"L1", "Hawthorne", {Strip::L1, 14, 15}},
    {"L1", "Leichhardt North", {Strip::L1, 16, 17}},
    {"L1", "Lilyfield", {Strip::L1, 18, 19}},
    {"L1", "Rozelle Bay", {Strip::L1, 20, 21}},
    {"L1", "Jubilee Park", {Strip::L1, 22, 23}},
    {"L1", "Glebe", {Strip::L1, 24, 25}},
    {"L1", "Wentworth Park", {Strip::L1, 26, 27}},
    {"L1", "Bank Street", {Strip::L1, 28, 29}},
    {"L1", "John Street Square", {Strip::L1, 30, 31}},
    {"L1", "The Star", {Strip::L1, 32, 33}},
    {"L1", "Pyrmont Bay", {Strip::L1, 34, 35}},
    {"L1", "Convention", {Strip::L1, 36, 37}},
    {"L1", "Exhibition Centre", {Strip::L1, 38, 39}},
    {"L1", "Paddy's Markets", {Strip::L1, 40, 41}},
    {"L1", "Capitol Square", {Strip::L1, 42, 43}},
    {"L1", "Central", {Strip::L1, 44, 44}},

    // L2 exclusive branch, followed by its shared L3 physical trunk.
    {"L2", "Randwick", {Strip::L2, 0, 1}},
    {"L2", "UNSW High Street", {Strip::L2, 2, 3}},
    {"L2", "Wansey Road", {Strip::L2, 4, 5}},
    {"L2", "Royal Randwick", {Strip::L2, 6, 7}},
    {"L2", "Moore Park", {Strip::L3, 10, 11}},
    {"L2", "Surry Hills", {Strip::L3, 12, 13}},
    {"L2", "Central", {Strip::L3, 14, 15}},
    {"L2", "Haymarket", {Strip::L3, 16, 17}},
    {"L2", "Chinatown", {Strip::L3, 18, 19}},
    {"L2", "Town Hall", {Strip::L3, 20, 21}},
    {"L2", "QVB", {Strip::L3, 22, 23}},
    {"L2", "Wynyard", {Strip::L3, 24, 25}},
    {"L2", "Bridge Street", {Strip::L3, 26, 27}},
    {"L2", "Circular Quay", {Strip::L3, 28, 29}},

    // L3: Juniors Kingsford -> Circular Quay, GPIO18.
    {"L3", "Juniors Kingsford", {Strip::L3, 0, 1}},
    {"L3", "Kingsford", {Strip::L3, 2, 3}},
    {"L3", "UNSW Anzac Parade", {Strip::L3, 4, 5}},
    {"L3", "Kensington", {Strip::L3, 6, 7}},
    {"L3", "ES Marks", {Strip::L3, 8, 9}},
    {"L3", "Moore Park", {Strip::L3, 10, 11}},
    {"L3", "Surry Hills", {Strip::L3, 12, 13}},
    {"L3", "Central", {Strip::L3, 14, 15}},
    {"L3", "Haymarket", {Strip::L3, 16, 17}},
    {"L3", "Chinatown", {Strip::L3, 18, 19}},
    {"L3", "Town Hall", {Strip::L3, 20, 21}},
    {"L3", "QVB", {Strip::L3, 22, 23}},
    {"L3", "Wynyard", {Strip::L3, 24, 25}},
    {"L3", "Bridge Street", {Strip::L3, 26, 27}},
    {"L3", "Circular Quay", {Strip::L3, 28, 29}},

    // L4: Carlingford -> Westmead, GPIO19.
    {"L4", "Carlingford", {Strip::L4, 0, 1}},
    {"L4", "Telopea", {Strip::L4, 2, 3}},
    {"L4", "Dundas", {Strip::L4, 4, 5}},
    {"L4", "Yallamundi", {Strip::L4, 6, 7}},
    {"L4", "Rosehill Gardens", {Strip::L4, 8, 9}},
    {"L4", "Tramway Avenue", {Strip::L4, 10, 11}},
    {"L4", "Robin Thomas", {Strip::L4, 12, 13}},
    {"L4", "Parramatta Square", {Strip::L4, 14, 15}},
    {"L4", "Church Street", {Strip::L4, 16, 17}},
    {"L4", "Prince Alfred Square", {Strip::L4, 18, 19}},
    {"L4", "Fennell Street", {Strip::L4, 20, 21}},
    {"L4", "Benaud Oval", {Strip::L4, 22, 23}},
    {"L4", "Ngara", {Strip::L4, 24, 25}},
    {"L4", "Childrens Hospital", {Strip::L4, 26, 27}},
    {"L4", "Westmead Hospital", {Strip::L4, 28, 29}},
    {"L4", "Westmead", {Strip::L4, 30, 31}},
};

constexpr size_t kStationBindingCount =
    sizeof(kStationBindings) / sizeof(kStationBindings[0]);

constexpr uint8_t stripIndex(Strip strip) {
  return static_cast<uint8_t>(strip);
}

constexpr uint32_t routeColour(const char *route) {
  return route[1] == '1'   ? kRouteLedColours[0]
         : route[1] == '2' ? kRouteLedColours[1]
         : route[1] == '3' ? kRouteLedColours[2]
                           : kRouteLedColours[3];
}

static_assert(kStationBindingCount == 68,
              "Unexpected station binding count");
static_assert(kStripLengths[0] == 45 && kStripLengths[1] == 8 &&
                  kStripLengths[2] == 30 && kStripLengths[3] == 32,
              "Strip lengths must match the PCB data chains");

}  // namespace tramtrace
