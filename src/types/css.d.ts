// TS 7 (native compiler) requires an explicit module declaration for
// side-effect CSS imports that TS 5.x silently tolerated (TS2882).
declare module '*.css';
