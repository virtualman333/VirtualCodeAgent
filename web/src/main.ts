import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
// TDesign 基础组件样式 (ChatList/ChatSender 内部依赖 Button/Textarea/Tooltip 等)
import "tdesign-vue-next/es/style/index.css";

createApp(App).mount("#app");
