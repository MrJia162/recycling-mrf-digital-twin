import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Bot,
  Boxes,
  Cpu,
  Factory,
  Gauge,
  Hexagon,
  Layers,
  Package,
  Pause,
  Play,
  Radar,
  RotateCcw,
  Settings,
  Users,
} from "lucide-react";
import ActualScene, { type CameraView } from "./ActualScene";
import { ActualSimulation, deviceStatus, openGate, statusTone } from "./engine";
import {
  CAPACITY,
  EQUIPMENT,
  EQUIPMENT_FLOW_IDS,
  EQUIPMENT_IDS,
  MATERIALS,
  PLAYBACK_HORIZON,
  PARAMETER_LIMITS,
  SMALL_GRADES,
  type EquipmentId,
  type Parameter,
} from "./process";
import "./actual.css";

const PARAMETERS: {
  id: Parameter;
  label: string;
  unit: string;
  step: number;
}[] = [
  { id: "feedRate", label: "上料节拍", unit: "批/min", step: 10 },
  { id: "beltSpeed", label: "输送倍率", unit: "×", step: 0.1 },
  { id: "threshold", label: "成品仓打包阈值", unit: "批", step: 1 },
  { id: "robotSpeed", label: "机械手动作倍率", unit: "×", step: 0.1 },
];
const STOPS = [
  { time: 0, label: "上料" },
  { time: 35, label: "人工 / 脱标" },
  { time: 60, label: "二次分选" },
  { time: 100, label: "自动打包" },
];
const SILO_DEVICE_IDS = new Set<EquipmentId>(["E02", "E03", "E04", "E05"]);
const SORTER_SHOTS = [
  "001.png",
  "002.png",
  "003.png",
  "004.png",
  "005.png",
  "006.png",
];
const DEVICE_ICONS: Record<string, typeof Cpu> = {
  分选: Cpu,
  机械手: Bot,
  打包: Package,
  仓: Boxes,
  平台: Users,
  脱标: Settings,
  输送: Layers,
  皮带: Layers,
  爬坡: Layers,
  链板: Layers,
  螺旋: Layers,
};
function DeviceIcon({ id }: { id: EquipmentId }) {
  const name = EQUIPMENT[id];
  const key = Object.keys(DEVICE_ICONS).find((token) => name.includes(token));
  const Icon = key ? DEVICE_ICONS[key] : Factory;
  return (
    <span className="device-hex">
      <Hexagon className="device-hex-frame" size={32} strokeWidth={1.1} />
      <Icon className="device-hex-icon" size={14} strokeWidth={1.6} />
    </span>
  );
}
function formatTime(time: number) {
  return `${Math.floor(time / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(time % 60)
    .toString()
    .padStart(2, "0")}`;
}
function formatClock(date: Date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

export default function ActualApp() {
  const ref = useRef<ActualSimulation | null>(null);
  if (!ref.current) ref.current = new ActualSimulation();
  const simulation = ref.current;
  const [, tick] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const [playing, setPlaying] = useState(
    () =>
      !(
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ),
  );
  const [speed, setSpeed] = useState(1),
    [selected, setSelected] = useState<EquipmentId | null>(null);
  const [showStandardSections, setShowStandardSections] = useState(false);
  const [showPlayback, setShowPlayback] = useState(false);
  const [view, setView] = useState<CameraView>("overview");
  const [zoomShot, setZoomShot] = useState<number | null>(null);
  const [xray, setXray] = useState(false),
    [paths, setPaths] = useState(false),
    [shell, setShell] = useState(false);
  const refresh = useCallback(() => tick((value) => value + 1), []);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (zoomShot === null) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [zoomShot]);
  useEffect(() => {
    let handle = 0,
      last = performance.now(),
      uiTime = 0;
    const frame = (now: number) => {
      handle = requestAnimationFrame(frame);
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!playing || document.hidden) return;
      simulation.advanceBy(
        Math.min(
          delta * speed,
          Math.max(0, PLAYBACK_HORIZON - simulation.current.time),
        ),
      );
      uiTime += delta;
      if (uiTime >= 0.12) {
        refresh();
        uiTime = 0;
      }
      if (simulation.current.time >= PLAYBACK_HORIZON) {
        simulation.seek(0);
        refresh();
      }
    };
    handle = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(handle);
  }, [playing, speed, simulation, refresh]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        setZoomShot(null);
        return;
      }
      if (
        (event.target as HTMLElement)?.closest?.("input,select,textarea,button")
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const selectDevice = useCallback((id: EquipmentId) => {
    setSelected(id);
    setShowStandardSections(id !== "E17");
    setView("focus");
  }, []);
  const seek = (time: number) => {
    simulation.seek(time);
    setPlaying(false);
    refresh();
  };
  const state = simulation.current,
    status = selected ? deviceStatus(state, selected) : "",
    tone = selected ? statusTone(status) : "";
  const baled = state.bales.reduce((sum, bale) => sum + bale.count, 0);
  const job = state.job;
  const gate = openGate(state) ? `${openGate(state)} 开启` : "两仓关闭";
  const powered = EQUIPMENT_IDS.filter((id) => state.power[id]).length;
  const tones = EQUIPMENT_IDS.map((id) => statusTone(deviceStatus(state, id)));
  const runCount = tones.filter((value) => value === "run").length;
  const warnCount = tones.filter((value) => value === "warn").length;
  const alarmCount = tones.filter((value) => value === "alarm").length;
  const working = state.units.filter(
    (unit) =>
      unit.stage === "moving" ||
      unit.stage === "press" ||
      unit.stage === "carried",
  ).length;
  const health = Math.round((powered / EQUIPMENT_IDS.length) * 100);
  const play = () => {
    if (!playing && state.time >= PLAYBACK_HORIZON) simulation.seek(0);
    setPlaying((value) => !value);
    refresh();
  };

  return (
    <div className="actual-app">
      <header className="actual-header">
        <div className="actual-brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <span className="eyebrow">RELOOP · TONGXIANG</span>
            <span className="brand-sub">MRF DIGITAL TWIN</span>
          </div>
        </div>
        <div className="actual-title">
          <i className="title-wing" aria-hidden="true" />
          <div className="title-core">
            <h1>
              <span>桐乡分拣中心</span>
            </h1>
            <small>INDOOR RECYCLING SORTING CENTER</small>
          </div>
          <i className="title-wing reverse" aria-hidden="true" />
        </div>
        <div className="actual-header-side">
          <span className="live-chip">
            <i />
            系统在线
          </span>
          <span className="header-clock">{formatClock(clock)}</span>
          <a
            className="header-link"
            href="./index.html"
            aria-expanded={showPlayback}
            onClick={(event) => {
              event.preventDefault();
              setShowPlayback((value) => !value);
            }}
          >
            原演示
          </a>
        </div>
      </header>

      <main className="actual-workspace">
        <aside className="actual-devices panel-frame" aria-label="设备状态列表">
          <div className="panel-title">
            <span className="panel-title-mark">《</span>
            <h2>设备状态</h2>
            <small>EQUIPMENT STATUS</small>
          </div>
          <div className="device-list">
            {EQUIPMENT_FLOW_IDS.map((id) => {
              const deviceState = deviceStatus(state, id);
              const deviceTone = statusTone(deviceState);
              return (
                <button
                  key={id}
                  className={`device-row ${selected === id ? "selected" : ""}`}
                  onClick={() => selectDevice(id)}
                  aria-pressed={selected === id}
                  aria-label={`${id} ${EQUIPMENT[id]} ${deviceState}`}
                >
                  <DeviceIcon id={id} />
                  <span className="device-meta">
                    <b>{DEVICE_NAMES[id]}</b>
                    <small>
                      {id} · {EQUIPMENT[id]}
                    </small>
                  </span>
                  <span className={`device-status ${deviceTone}`}>
                    {deviceState}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="device-summary">
            <div
              className="health-ring"
              style={
                {
                  "--ring-angle": `${health * 3.6}deg`,
                } as CSSProperties
              }
            >
              <span>
                {health}
                <small>%</small>
              </span>
            </div>
            <div className="device-summary-meta">
              <strong>
                <Gauge size={13} /> 产线健康度
              </strong>
              <span>
                <i className="run" />
                运行 {runCount}
                <i className="warn" />
                预警 {warnCount}
                <i className="alarm" />
                告警 {alarmCount}
              </span>
            </div>
          </div>
        </aside>

        <section className="actual-stage" aria-label="实际产线三维动画">
          <ActualScene
            simulation={simulation}
            selected={selected}
            onSelect={selectDevice}
            xray={xray}
            paths={paths}
            shell={shell}
            view={view}
          />
          <div className="actual-view-tools" aria-label="三维视图控制">
            <div>
              {(
                [
                  ["overview", "全线"],
                  ["top", "俯视"],
                  ["focus", "聚焦设备"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={view === id}
                  onClick={() => {
                    if (id !== "focus") {
                      setSelected(null);
                      setShowStandardSections(false);
                    }
                    setView(id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <button
                aria-pressed={xray}
                onClick={() => setXray((value) => !value)}
              >
                工艺透视
              </button>
              <button
                aria-pressed={paths}
                onClick={() => setPaths((value) => !value)}
              >
                流向
              </button>
              <button
                aria-pressed={shell}
                onClick={() => setShell((value) => !value)}
              >
                厂房
              </button>
            </div>
          </div>
          <div className="material-legend">
            {(["3A", "MIXED", "GREEN", "BROWN"] as const).map((grade) => (
              <span key={grade}>
                <i style={{ background: MATERIALS[grade].color }} />
                {MATERIALS[grade].name}
              </span>
            ))}
            <span>
              <i style={{ background: "#e9bf75" }} />
              人工分拣支路
            </span>
          </div>
        </section>

        <aside className="actual-inspector" aria-label="实际设备详情与工艺控制">
          <section className="equipment-detail panel-frame">
            <div className="panel-title">
              <span className="panel-title-mark">《</span>
              <h2>设备详情</h2>
              {selected && (
                <span className={`device-state ${tone}`}>{status}</span>
              )}
            </div>
            <div className="panel-body">
              <label className="sr-only" htmlFor="actual-device">
                选择实际设备
              </label>
              <select
                id="actual-device"
                value={selected ?? ""}
                onChange={(event) => {
                  const id = event.target.value as EquipmentId;
                  if (id) selectDevice(id);
                }}
              >
                <option value="" disabled>
                  请选择设备
                </option>
                {EQUIPMENT_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id} · {EQUIPMENT[id]}
                  </option>
                ))}
              </select>
              {selected ? (
                <>
                  <h2 className="equipment-name">
                    <span>{selected}</span>
                    {EQUIPMENT[selected]}
                  </h2>
                  <label className="power-switch">
                    <span>模拟设备启用</span>
                    <input
                      type="checkbox"
                      checked={state.power[selected]}
                      onChange={(event) => {
                        simulation.setPower(selected, event.target.checked);
                        refresh();
                      }}
                    />
                  </label>
                  {selected === "E17" && (
                    <div className="sorter-detail">
                      <p>
                        <span>简介</span>
                        自研“AI
                        分选机”，按识别结果将材质分出三色瓶（PET）与杂瓶，分别风送至
                        E02、E03
                        中转仓，搭载“自研训练大模型”，实现现场实际使用，反馈训练，迭代优化的正反馈使用场景。
                      </p>
                      <dl>
                        <div>
                          <dt>分拣次数</dt>
                          <dd>{state.sorted} 次</dd>
                        </div>
                        <div>
                          <dt>识别精度</dt>
                          <dd>99.2 %</dd>
                        </div>
                      </dl>
                      {view === "focus" && (
                        <div className="sorter-shots">
                          <span>识别照片</span>
                          <div>
                            {SORTER_SHOTS.map((name, index) => (
                              <button
                                key={name}
                                type="button"
                                className="sorter-shot"
                                aria-label={`放大识别照片 ${index + 1}`}
                                onClick={() => setZoomShot(index)}
                              >
                                <img
                                  src={
                                    new URL(
                                      `./actual-assets/images/${name}`,
                                      document.baseURI,
                                    ).href
                                  }
                                  alt={`分选机识别照片 ${index + 1}`}
                                  loading="lazy"
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="device-empty">
                  点击左侧设备列表或三维视图中的设备查看详情。
                </p>
              )}
            </div>
          </section>

          {showStandardSections && (
            <>
              {selected !== null && SILO_DEVICE_IDS.has(selected) && (
                <section
                  className="silo-panel panel-frame"
                  aria-label="四个料仓库存"
                >
                  <div className="panel-title">
                    <span className="panel-title-mark">《</span>
                    <h2>料仓存量</h2>
                    <small>SILO STOCK</small>
                  </div>
                  <div className="panel-body">
                    {(["E02", "E03", "E04", "E05"] as const).map((id) => {
                      const count = state.stocks[id].length,
                        color =
                          id === "E04"
                            ? MATERIALS["3A"].color
                            : id === "E05"
                              ? MATERIALS.MIXED.color
                              : id === "E03"
                                ? "#e9bf75"
                                : "#5bd7ac";
                      return (
                        <button
                          className={`silo-row ${selected === id ? "selected" : ""}`}
                          key={id}
                          onClick={() => selectDevice(id)}
                          aria-label={`${id} ${EQUIPMENT[id]} ${count}批`}
                        >
                          <span>
                            {id} ·{" "}
                            {id === "E02"
                              ? "三色中转"
                              : id === "E03"
                                ? "杂瓶中转"
                                : id === "E04"
                                  ? "3A 成品"
                                  : "杂色 PET 成品"}
                          </span>
                          <strong>{count} %</strong>
                          <span className="stock-track">
                            <i
                              style={{
                                width: `${(count / CAPACITY) * 100}%`,
                                background: color,
                              }}
                            />
                            {(id === "E04" || id === "E05") && (
                              <b
                                style={{
                                  left: `${(state.settings.threshold / CAPACITY) * 100}%`,
                                }}
                              />
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
              <details className="small-stock-panel panel-frame">
                <summary>
                  <span className="panel-title-mark">《</span>
                  独立小仓位
                </summary>
                <div>
                  {SMALL_GRADES.map((grade) => (
                    <p key={grade}>
                      <i style={{ background: MATERIALS[grade].color }} />
                      {MATERIALS[grade].name}
                      <strong>{state.stocks[grade].length}</strong>
                    </p>
                  ))}
                </div>
                <small>每 4 批申请人工转运，共用同一打包资源。</small>
              </details>
              {selected === "E13" && (
                <section
                  className="baler-panel panel-frame"
                  aria-label="共用打包资源"
                >
                  <div className="panel-title">
                    <span className="panel-title-mark">《</span>
                    <h2>打包机状态</h2>
                    <small>BALER</small>
                  </div>
                  <div className="panel-body">
                    <p className="gate-status">
                      仓门互锁 <span>{gate}</span>
                    </p>
                    <div className="packing-stages">
                      {["供料", "压缩", "出包"].map((name, index) => (
                        <span
                          key={name}
                          className={
                            job &&
                            (job.phase === "EJECTING"
                              ? index === 2
                              : job.phase === "COMPRESSING"
                                ? index === 1
                                : index === 0)
                              ? "active"
                              : ""
                          }
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              <details className="actual-parameters panel-frame">
                <summary>
                  <span className="panel-title-mark">《</span>
                  模拟参数 <span className="summary-note">可调整</span>
                </summary>
                {PARAMETERS.map((parameter) => (
                  <label key={parameter.id}>
                    <span>
                      {parameter.label}
                      <strong>
                        {state.settings[parameter.id].toFixed(
                          parameter.step < 1 ? 1 : 0,
                        )}{" "}
                        {parameter.unit}
                      </strong>
                    </span>
                    <input
                      type="range"
                      aria-label={parameter.label}
                      min={PARAMETER_LIMITS[parameter.id][0]}
                      max={PARAMETER_LIMITS[parameter.id][1]}
                      step={parameter.step}
                      value={state.settings[parameter.id]}
                      onChange={(event) => {
                        simulation.setParameter(
                          parameter.id,
                          Number(event.target.value),
                        );
                        refresh();
                      }}
                    />
                  </label>
                ))}
                <small>调整按当前时刻记录，拖回历史可重放。</small>
              </details>
              <section
                className="actual-events panel-frame"
                aria-label="最近生产事件"
              >
                <div className="panel-title">
                  <span className="panel-title-mark">《</span>
                  <h2>AI 事件</h2>
                  <small>
                    <Radar size={11} /> LIVE EVENTS
                  </small>
                </div>
                <div className="panel-body">
                  {state.events.length === 0 && (
                    <p className="event-empty">
                      <time>{formatTime(state.time)}</time>
                      等待产线事件…
                    </p>
                  )}
                  {state.events
                    .slice(-4)
                    .reverse()
                    .map((event, index) => (
                      <p key={`${event.time}-${index}`}>
                        <time>{formatTime(event.time)}</time>
                        {event.text}
                      </p>
                    ))}
                </div>
              </section>
            </>
          )}
        </aside>
      </main>

      {showPlayback && (
        <footer className="actual-playback">
          <div className="playback-controls">
            <button
              className="play-button"
              onClick={play}
              aria-label={
                playing
                  ? "暂停"
                  : state.time >= PLAYBACK_HORIZON
                    ? "重播"
                    : "播放"
              }
            >
              {playing ? (
                <Pause size={18} />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </button>
            <button
              className="reset-button"
              aria-label="重置实际产线"
              onClick={() => {
                simulation.reset();
                setPlaying(false);
                refresh();
              }}
            >
              <RotateCcw size={17} />
            </button>
            <select
              aria-label="播放倍速"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
            <span className="playback-time">
              {formatTime(state.time)}
              <small> / {formatTime(PLAYBACK_HORIZON)}</small>
            </span>
          </div>
          <div className="actual-timeline">
            <label className="sr-only" htmlFor="actual-time">
              实际产线时间轴
            </label>
            <input
              id="actual-time"
              type="range"
              min={0}
              max={PLAYBACK_HORIZON}
              step={0.1}
              value={state.time}
              onChange={(event) => seek(Number(event.target.value))}
            />
            <div className="actual-milestones">
              {STOPS.map((stop) => (
                <button
                  key={stop.time}
                  onClick={() => seek(stop.time)}
                  style={{ left: `${(stop.time / PLAYBACK_HORIZON) * 100}%` }}
                >
                  {stop.label}
                </button>
              ))}
            </div>
          </div>
          <section className="actual-metrics" aria-label="产线模拟统计">
            <div>
              <span>累计上料</span>
              <strong data-testid="received-count">
                {state.units.length}
                <small>批</small>
              </strong>
            </div>
            <div>
              <span>已打包</span>
              <strong data-testid="baled-count">
                {baled}
                <small>批 / {state.bales.length} 包</small>
              </strong>
            </div>
            <div>
              <span>在制物料</span>
              <strong>
                {working}
                <small>批</small>
              </strong>
            </div>
          </section>
        </footer>
      )}
      {zoomShot !== null && (
        <div
          className="sorter-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="识别照片预览"
          onClick={() => setZoomShot(null)}
        >
          <button
            type="button"
            className="sorter-lightbox-close"
            aria-label="关闭预览"
            autoFocus
            onClick={() => setZoomShot(null)}
          >
            ×
          </button>
          <img
            src={
              new URL(
                `./actual-assets/images/${SORTER_SHOTS[zoomShot]}`,
                document.baseURI,
              ).href
            }
            alt={`分选机识别照片 ${zoomShot + 1}`}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

const DEVICE_NAMES: Record<EquipmentId, string> = {
  E02: "三色中转仓",
  E03: "杂瓶中转仓",
  E04: "3A 成品仓",
  E05: "杂色 PET 仓",
  E06: "上料爬坡机",
  E07: "杂瓶爬坡机",
  E08: "出包输送带",
  E09: "脱标爬坡机",
  E10: "链板提升机",
  E11: "螺旋上料机",
  E12: "脱标机",
  E13: "自动打包机",
  E14: "人工分拣平台",
  E15: "并联机械手",
  E16: "机械手输送带",
  E17: "AI 分选机",
  E18: "二次分选机",
};
