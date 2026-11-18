// Gallery: every core control and style prop, one page per state
// ({ page }), for the golden logs, the Swift snapshot test (which draws each
// page: Tests/SolidWatchTests/GalleryTests.swift) and the demo app. Pages:
// 0 buttons, 1 toggles, 2 crown, 3 progress, 4 icons and images, 5 text,
// 6 colours, 7 a scrolling list.
import { createSignal, For, Match, Switch } from "solid-js";
import { createApp, hostVersion } from "solid-watch";

// a 32 x 32 RGBA PNG: an arrow pointing up (orange to red) on transparent
const ARROW =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA8klEQVR42sXNIUsEYRhF4Zvv7zEIBsEgGATBIBgEgyAYBINgEAyCYBAMwgbBn3osW1xn9v3uN7NMeOo54sdakvj2osTKU7DW3RBfnoK17ob4dC82dHXEh3swIm6Jd6coRD3x5gSNmpvi1a0INXXFi1vQqWyLZ1eYaGtfPHkbZjL6EI8ew8wGP+LBY5jZ4Efcewg78u8l7ryJHfvzE7dOUYh64sYpClFPXDtFIeqJK6coRD1x6RSFqCcunKIQ9cS5UxSinjhzikLUE6dOUYh64sQpClFPHDtFIeqJI6coRD1x6BSFqCcOnKIQ9cS+FyX2vKhfH77sOT7R/kAAAAAASUVORK5CYII=";

const PAGES = ["Buttons", "Toggles", "Crown", "Progress", "Icons", "Text", "Colors", "List"];
const [page, setPage] = createSignal(0);
const [presses, setPresses] = createSignal(0);
const [held, setHeld] = createSignal(0);
const [segment, setSegment] = createSignal(1);
const [wifi, setWifi] = createSignal(true);
const [alarm, setAlarm] = createSignal(false);
const [target, setTarget] = createSignal(4);
const [angle, setAngle] = createSignal(0);

const Pill = (props) => (
  <button flexGrow={1} flexBasis={0} height={34} alignItems="center" justifyContent="center" {...props} />
);

// a segmented control: buttons in a row, the outer corners rounded
const Segments = () => (
  <view flexDirection="row" gap={1} height={30}>
    <For each={["S", "M", "L"]}>
      {(label, i) => (
        <button flexGrow={1} flexBasis={0} alignItems="center" justifyContent="center"
                background={segment() === i() ? "blue" : "gray5"}
                borderTopLeftRadius={i() === 0 ? 9 : 2} borderBottomLeftRadius={i() === 0 ? 9 : 2}
                borderTopRightRadius={i() === 2 ? 9 : 2} borderBottomRightRadius={i() === 2 ? 9 : 2}
                onPress={() => setSegment(i())}>
          <text fontSize={14} fontWeight="600">{label}</text>
        </button>
      )}
    </For>
  </view>
);

function Buttons() {
  return (
    <view gap={5}>
      <view flexDirection="row" gap={5}>
        <Pill background="blue" borderRadius={999} pressedScale={0.94} pressedOpacity={1} onPress={() => setPresses((n) => n + 1)}>
          <text fontWeight="600">Filled</text>
        </Pill>
        <Pill background="#0A84FF40" borderRadius={999} onPress={() => setPresses((n) => n + 1)}>
          <text fontWeight="600" color="blue">Tinted</text>
        </Pill>
      </view>
      <view flexDirection="row" gap={5}>
        <Pill background="gray5" pressedBackground="gray3" pressedOpacity={1} borderRadius={10} onPress={() => setPresses((n) => n + 1)}>
          <text>Plain</text>
        </Pill>
        <Pill borderWidth={1.5} borderColor="gray3" borderRadius={10} disabled>
          <text color="gray">Off</text>
        </Pill>
      </view>
      <Segments />
      <button height={34} borderRadius={10} background="red" alignItems="center" justifyContent="center"
              onLongPress={() => setHeld((n) => n + 1)} onPress={() => setPresses((n) => n + 1)}>
        <text fontWeight="600">Hold me</text>
      </button>
      <text fontSize={13} color="gray" tabular>{`presses ${presses()} · holds ${held()}`}</text>
    </view>
  );
}

// a toggle row: the whole row is the button; its toggle only draws
const Row = (props) => (
  <button flexDirection="row" alignItems="center" height={38} paddingHorizontal={10} borderRadius={10}
          background="gray6" onPress={props.onPress}>
    <text flexGrow={1} flexShrink={1} numberOfLines={1}>{props.label}</text>
    <toggle value={props.value} activeTrackColor={props.color} />
  </button>
);

function Toggles() {
  return (
    <view gap={5}>
      <Row label="Wi-Fi" value={wifi()} onPress={() => setWifi((v) => !v)} />
      <Row label="Alarm" value={alarm()} color="orange" onPress={() => setAlarm((v) => !v)} />
      <view flexDirection="row" alignItems="center" gap={8} paddingHorizontal={10}>
        <toggle value={alarm()} onChange={setAlarm} />
        <toggle value={true} disabled />
        <toggle value={false} inactiveTrackColor="#FFFFFF26" thumbColor="yellow" width={52} height={30} />
      </view>
    </view>
  );
}

function Crown() {
  return (
    <view alignItems="center" gap={6}>
      <crown value={target()} min={0} max={10} increment={0.5} sensitivity="low" onChange={setTarget} />
      <text fontSize={13} color="gray" letterSpacing={1.5}>VOLUME</text>
      <text fontSize={52} fontWeight="700" tabular>{target().toFixed(1)}</text>
      <progress alignSelf="stretch" height={8} value={target() / 10} color="green" />
      <view flexDirection="row" gap={5} alignSelf="stretch">
        <Pill background="gray5" borderRadius={999} onPress={() => setTarget((v) => Math.max(0, v - 0.5))}><text fontSize={20}>−</text></Pill>
        <Pill background="gray5" borderRadius={999} onPress={() => setTarget((v) => Math.min(10, v + 0.5))}><text fontSize={20}>+</text></Pill>
      </view>
    </view>
  );
}

function Progress() {
  return (
    <view gap={6}>
      <progress height={6} value={0.3} />
      <progress height={10} value={0.72} color="orange" trackColor="gray5" />
      <view flexDirection="row" justifyContent="space-between" alignItems="center">
        <progress shape="ring" width={64} height={64} value={0.62} color="green" thickness={7} alignItems="center" justifyContent="center">
          <text fontSize={15} fontWeight="700" tabular>62%</text>
        </progress>
        <progress shape="arc" width={64} height={64} value={0.4} color="yellow" thickness={6} alignItems="center" justifyContent="center">
          <text fontSize={15} fontWeight="700" tabular>4.0</text>
        </progress>
        <progress width={10} height={64} value={0.55} color="cyan" />
      </view>
      <progress shape="ring" width={30} height={30} value={0} thickness={4} />
    </view>
  );
}

function Icons() {
  return (
    <view gap={6}>
      <crown value={angle()} min={0} max={360} increment={5} wrap onChange={setAngle} />
      <view flexDirection="row" justifyContent="space-between" alignItems="center">
        <icon name="heart.fill" color="red" />
        <icon name="bolt.fill" size={22} weight="bold" color="cyan" />
        <icon name="leaf.fill" size={22} renderingMode="hierarchical" color="green" />
        <icon name="sun.max.fill" size={22} renderingMode="multicolor" />
        <icon name="location.north.fill" size={22} color="orange" rotate={angle()} />
      </view>
      <view flexDirection="row" justifyContent="space-between">
        <For each={["cover", "contain", "stretch", "center"]}>
          {(mode) => (
            <image source={ARROW} resizeMode={mode} width={40} height={28} background="gray5" borderRadius={6} />
          )}
        </For>
      </view>
      <view flexDirection="row" gap={8} alignItems="center">
        <image source={ARROW} tintColor="mint" width={24} height={24} resizeMode="contain" />
        <view width={24} height={24} background="purple" borderRadius={4} rotate={45} scale={0.8} />
        <text fontSize={14} tabular>{`${angle()}°`}</text>
        <image source="data:image/svg+xml;base64,PHN2Zy8+" width={20} height={20} borderWidth={1} borderColor="gray3" />
      </view>
    </view>
  );
}

function Text() {
  return (
    <view gap={3}>
      <text fontSize={11} color="gray" letterSpacing={2}>STEPS TODAY</text>
      <text fontSize={44} fontWeight="800" tabular minScale={0.5}>8,412</text>
      <view flexDirection="row" alignItems="baseline" gap={4}>
        <text fontSize={19} fontWeight="300">light</text>
        <text fontSize={19} fontWeight="500">medium</text>
        <text fontSize={19} fontWeight="900">black</text>
      </view>
      <text fontSize={14} numberOfLines={2} lineHeight={17}>A long line that wraps once and then is cut with an ellipsis at the end of line two.</text>
      <text fontSize={15} textAlign="center">mixed <text color="orange" fontWeight="700">spans</text> and <text color="mint" letterSpacing={3}>space</text></text>
    </view>
  );
}

const SWATCHES = ["red", "orange", "yellow", "green", "mint", "teal", "cyan", "blue", "indigo", "purple", "pink", "brown", "gray", "gray2", "gray3", "gray4", "gray5", "gray6"];

function Colors() {
  return (
    <view flexDirection="row" flexWrap="wrap" gap={4}>
      <For each={SWATCHES}>
        {(c) => (
          <view width={44} height={36} borderRadius={7} background={c} padding={3} justifyContent="flex-end">
            <text fontSize={9} fontWeight="600" color={c.startsWith("gray") && c !== "gray" ? "white" : "black"}>{c}</text>
          </view>
        )}
      </For>
    </view>
  );
}

// a scrolling list with the system indicator
function List() {
  return (
    <scroll flexGrow={1} showsVerticalScrollIndicator>
      <view gap={4}>
        <For each={["Passport", "Charger", "Headphones", "Toothbrush", "Rain jacket", "Socks", "Book", "Snacks"]}>
          {(label, i) => (
            <view flexDirection="row" alignItems="center" gap={8} height={36} paddingHorizontal={10} borderRadius={10} background="gray6">
              <icon name="checkmark.circle.fill" size={14} color={i() % 2 ? "orange" : "green"} />
              <text flexGrow={1} flexShrink={1} numberOfLines={1}>{label}</text>
              <text fontSize={13} color="gray" tabular>{String(i() + 1)}</text>
            </view>
          )}
        </For>
      </view>
    </scroll>
  );
}

function App() {
  return (
    <view flexGrow={1} padding={4} gap={6}>
      <view flexDirection="row" justifyContent="space-between" alignItems="baseline">
        <text fontSize={15} fontWeight="700" color="orange" letterSpacing={1}>{PAGES[page()] ?? "?"}</text>
        <text fontSize={11} color="gray" tabular>{`v${hostVersion()} · ${page() + 1}/${PAGES.length}`}</text>
      </view>
      <Switch>
        <Match when={page() === 0}><Buttons /></Match>
        <Match when={page() === 1}><Toggles /></Match>
        <Match when={page() === 2}><Crown /></Match>
        <Match when={page() === 3}><Progress /></Match>
        <Match when={page() === 4}><Icons /></Match>
        <Match when={page() === 5}><Text /></Match>
        <Match when={page() === 6}><Colors /></Match>
        <Match when={page() === 7}><List /></Match>
      </Switch>
    </view>
  );
}

createApp(App, {
  onState(s) {
    if (s && typeof s.page === "number") setPage(s.page);
  },
});
