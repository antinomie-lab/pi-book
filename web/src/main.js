import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import Home from "./views/Home.vue";
import Chapter from "./views/Chapter.vue";
import "./style.css";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "home", component: Home },
    { path: "/chapter/:id", name: "chapter", component: Chapter },
  ],
  scrollBehavior(to, from, savedPosition) {
    // in-page anchors are scrolled by Chapter.vue after markdown renders
    if (to.hash) return false;
    return savedPosition ?? { top: 0 };
  },
});

createApp(App).use(router).mount("#app");
