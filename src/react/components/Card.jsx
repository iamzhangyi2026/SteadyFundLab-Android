// onClick 可选：传了就让整张卡任意位置都可点（is-clickable 负责 cursor/hover 语义）。
// 键盘/读屏的可达入口仍由卡内的真实按钮承担（如板块卡的图标按钮），
// 所以这里不给 section 加 role="button"，避免把整卡内容变成一个大按钮把内部语义吃掉。
export default function Card({ title, kicker, right, action, children, className = '', icon, state, onClick }) {
  const stateCls = Array.isArray(state) ? state.map((s) => `is-${s}`).join(' ') : state ? `is-${state}` : ''
  const clickable = typeof onClick === 'function'
  return (
    <section className={`card ${stateCls} ${clickable ? 'is-clickable' : ''} ${className}`} onClick={onClick}>
      {(title || kicker || right || action || icon) && (
        <header className="card-head">
          {icon && <div className="card-icon">{icon}</div>}
          <div className="card-title-group">
            {kicker && <div className="kicker">{kicker}</div>}
            {title && <h3 className="card-title">{title}</h3>}
          </div>
          {action}
          {right}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  )
}
