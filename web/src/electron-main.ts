import { createApp } from "vue";
import DesktopApp from "./components/DesktopApp.vue";
import "./style.css";
import "tdesign-vue-next/es/style/index.css";

// Electron 模式专用入口, 加载桌面布局组件
createApp(DesktopApp).mount("#app");